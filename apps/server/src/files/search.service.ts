import { Inject, Injectable, ServiceUnavailableException, BadRequestException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { FileRow } from './files.service';
import { MediaSettingsService } from './media-settings';
import { MlClient, MlError } from './ml-client';
import { PeopleService } from './people.service';

export interface SearchHit {
  file: FileRow;
  score: number;
}

export interface SearchStatus {
  enabled: boolean; // включено в админке
  available: boolean; // и ML-сервис отвечает
  total: number; // файлов человека, которые должны попасть в поиск
  indexed: number; // из них уже с вектором
}

// Матрица всех векторов текущей модели в памяти: 22 тысячи файлов по 512 чисел это около 45 МБ, перебор целиком занимает
// десятки миллисекунд. Отдельная база векторов (pgvector) такому облаку не нужна.
interface Matrix {
  model: string;
  stamp: string; // «сколько векторов и когда последний менялся»: по этому видно, что матрицу пора перечитать
  checkedAt: number;
  dim: number;
  index: Map<string, number>; // blob_id -> строка
  data: Float32Array;
}

const RECHECK_MS = 5000;
// Нижняя граница сходства: ниже этого файл не имеет отношения к запросу, даже если он «лучший из плохих».
// Мягкая, чтобы не отрезать нужное; уточняется на настоящих фото переменной DVCLOUD_SEARCH_MIN.
const MIN_SCORE = (() => {
  const v = Number(process.env.DVCLOUD_SEARCH_MIN ?? 0.1);
  return Number.isFinite(v) ? v : 0.1;
})();
const QUERY_CACHE = 50;

@Injectable()
export class SearchService {
  private matrix: Matrix | null = null;
  private loading: Promise<Matrix> | null = null;
  private readonly queries = new Map<string, { model: string; vector: Float32Array }>();

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(MlClient) private readonly ml: MlClient,
    @Inject(MediaSettingsService) private readonly settings: MediaSettingsService,
    @Inject(PeopleService) private readonly people: PeopleService,
  ) {}

  // Запрос с именами: «Валя», «Валя на пляже», «кот Ефим». Имена выбирают людей, остальное уточняет смыслом (если поиск по смыслу доступен).
  // Без совпадений с именами это обычный поиск по смыслу.
  async find(ownerId: string, q: string, limit: number): Promise<{ hits: SearchHit[]; status: SearchStatus; people: { id: string; name: string }[] }> {
    const pm = await this.people.matchNames(ownerId, q);
    if (pm.ids.length === 0) return { ...(await this.search(ownerId, q, limit)), people: [] };
    const people = await this.people.names(ownerId, pm.ids);
    if (!pm.rest) {
      const rows = await this.people.filesWithAll(ownerId, pm.ids, limit);
      return { hits: rows.map((file) => ({ file, score: 1 })), status: await this.status(ownerId), people };
    }
    // Имя и уточнение: сначала всё, что относится к людям, потом отбор по смыслу среди них.
    const mine = new Map((await this.people.filesWithAll(ownerId, pm.ids, 20_000)).map((f) => [f.id, f]));
    try {
      const r = await this.search(ownerId, pm.rest, 3000);
      return { hits: r.hits.filter((h) => mine.has(h.file.id)).slice(0, limit), status: r.status, people };
    } catch (e) {
      // Поиск по смыслу выключен или недоступен: показываем всех найденных людей, без уточнения.
      if (e instanceof ServiceUnavailableException) return { hits: [...mine.values()].slice(0, limit).map((file) => ({ file, score: 1 })), status: await this.status(ownerId), people };
      throw e;
    }
  }

  async status(ownerId: string): Promise<SearchStatus> {
    const s = await this.settings.get();
    const h = s.searchEnabled ? await this.ml.health() : null;
    const r = await this.db.query<{ total: string; indexed: string }>(
      `SELECT count(*) AS total, count(*) FILTER (WHERE e.status = 'ready' AND e.model = $2) AS indexed
       FROM files f LEFT JOIN embeddings e ON e.blob_id = f.blob_id
       WHERE f.owner_id = $1 AND f.trashed_at IS NULL AND (f.mime LIKE 'image/%' OR f.mime LIKE 'video/%')`,
      [ownerId, h?.model ?? null],
    );
    return { enabled: s.searchEnabled, available: !!h && h.ready, total: Number(r.rows[0].total), indexed: Number(r.rows[0].indexed) };
  }

  private async textVector(q: string): Promise<{ model: string; vector: Float32Array }> {
    const key = q.trim().toLowerCase();
    const hit = this.queries.get(key);
    if (hit) return hit;
    const r = await this.ml.text(q);
    const out = { model: r.model, vector: new Float32Array(r.vector.buffer.slice(r.vector.byteOffset, r.vector.byteOffset + r.vector.length)) };
    if (this.queries.size >= QUERY_CACHE) this.queries.delete(this.queries.keys().next().value as string);
    this.queries.set(key, out);
    return out;
  }

  private async load(model: string): Promise<Matrix> {
    const now = Date.now();
    const m = this.matrix;
    if (m && m.model === model && now - m.checkedAt < RECHECK_MS) return m;
    const st = await this.db.query<{ n: string; last: Date | null }>("SELECT count(*) AS n, max(updated_at) AS last FROM embeddings WHERE status = 'ready' AND model = $1", [model]);
    const stamp = `${st.rows[0].n}/${st.rows[0].last?.getTime() ?? 0}`;
    if (m && m.model === model && m.stamp === stamp) {
      m.checkedAt = now;
      return m;
    }
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const rows = (await this.db.query<{ blob_id: string; vector: Buffer }>("SELECT blob_id, vector FROM embeddings WHERE status = 'ready' AND model = $1 ORDER BY blob_id", [model])).rows;
      const dim = rows.length ? rows[0].vector.length / 4 : 0;
      const good = rows.filter((x) => x.vector.length === dim * 4);
      const data = new Float32Array(good.length * dim);
      const index = new Map<string, number>();
      good.forEach((x, i) => {
        data.set(new Float32Array(x.vector.buffer.slice(x.vector.byteOffset, x.vector.byteOffset + x.vector.length)), i * dim);
        index.set(x.blob_id, i);
      });
      const fresh: Matrix = { model, stamp, checkedAt: Date.now(), dim, index, data };
      this.matrix = fresh;
      return fresh;
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  // Поиск по файлам одного человека (только своя библиотека, без корзины). Возвращает лучшие, не слабее cutoff% от первого.
  async search(ownerId: string, q: string, limit: number): Promise<{ hits: SearchHit[]; status: SearchStatus }> {
    const s = await this.settings.get();
    if (!s.searchEnabled) throw new ServiceUnavailableException('Поиск по смыслу выключен администратором');
    if (!this.ml.configured) throw new ServiceUnavailableException('Поиск по смыслу не настроен на сервере');
    let qv: { model: string; vector: Float32Array };
    try {
      qv = await this.textVector(q);
    } catch (e) {
      if (e instanceof MlError && e.status === 400) throw new BadRequestException(e.message);
      throw new ServiceUnavailableException('Служба поиска сейчас недоступна, попробуйте позже');
    }
    let m = await this.load(qv.model);
    if (m.index.size === 0 && this.queries.has(q.trim().toLowerCase())) {
      // Вектор запроса мог остаться в кэше от прежней модели (модель сменили): считаем его заново один раз.
      this.queries.delete(q.trim().toLowerCase());
      try {
        qv = await this.textVector(q);
      } catch {
        throw new ServiceUnavailableException('Служба поиска сейчас недоступна, попробуйте позже');
      }
      m = await this.load(qv.model);
    }
    const status = await this.status(ownerId);
    if (m.index.size === 0 || m.dim !== qv.vector.length) return { hits: [], status };
    const mine = await this.db.query<{ id: string; blob_id: string }>(
      'SELECT id, blob_id FROM files WHERE owner_id = $1 AND trashed_at IS NULL AND blob_id IS NOT NULL',
      [ownerId],
    );
    const scored: { id: string; score: number }[] = [];
    const v = qv.vector;
    const dim = m.dim;
    for (const f of mine.rows) {
      const row = m.index.get(f.blob_id);
      if (row === undefined) continue;
      let dot = 0;
      const base = row * dim;
      for (let k = 0; k < dim; k++) dot += m.data[base + k] * v[k];
      scored.push({ id: f.id, score: dot });
    }
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0]?.score ?? 0;
    // Относительный порог: у «слабого» запроса лучшие совпадения тоже слабые, абсолютный порог тут не годится.
    const floor = best > 0 ? Math.max(MIN_SCORE, best * (s.searchCutoff / 100)) : Infinity;
    const top = scored.slice(0, limit).filter((x) => x.score >= floor);
    if (top.length === 0) return { hits: [], status };
    const rows = (await this.db.query<FileRow>('SELECT * FROM files WHERE id = ANY($1::bigint[])', [top.map((x) => x.id)])).rows;
    const byId = new Map(rows.map((x) => [x.id, x]));
    return { hits: top.filter((x) => byId.has(x.id)).map((x) => ({ file: byId.get(x.id)!, score: x.score })), status };
  }
}
