import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import sharp from 'sharp';
import { DbService } from '../db/db.service';
import { FileRow, ID_RE } from './files.service';
import { MediaSettingsService } from './media-settings';
import { prepareScan } from './scan-image';
import { StorageService } from './storage.service';

// Насколько похожи два лица (скалярное произведение нормированных векторов SFace), чтобы считать их одним человеком.
// OpenCV рекомендует 0,363 для проверки двух снимков; для сбора групп берём строже: лишнюю группу легко объединить
// вручную, а чужое лицо в группе придётся искать глазами. Порог для лиц теперь в настройках админки (facesSim, по умолчанию 45). Для питомцев (вектор CLIP по вырезанному кадру) порог выше:
// все кошки между собой похожи сильнее, чем люди. Порог питомцев можно подстроить переменной окружения.
const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : d;
};
export const PET_SIM = num(process.env.DVCLOUD_PET_SIM, 0.9);
// Новая безымянная группа заводится, когда в ней набралось хотя бы столько находок: так случайные лица в толпе не засоряют список.
export const MIN_GROUP = 3;

export type PersonKind = 'person' | 'pet';
const KINDS: Record<PersonKind, string[]> = { person: ['face'], pet: ['cat', 'dog'] };

export interface PersonInfo {
  id: string;
  name: string | null;
  kind: PersonKind;
  hidden: boolean;
  count: number; // файлов человека (вне корзины), на которых он есть
  cover: string; // id находки для обложки (лицо или питомец)
}

export interface FileFace {
  id: string; // id находки
  kind: 'face' | 'cat' | 'dog';
  box: [number, number, number, number]; // x, y, ширина, высота в долях картинки
  personId: string | null;
  name: string | null;
}

function f32(b: Buffer): Float32Array {
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function normalize(v: Float32Array): void {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
}

export interface FreeDet { id: string; v: Float32Array }

// Разложить свободные находки: к существующим группам (по центру группы), остальные в новые группы. Порядок входа важен
// (лучшие находки первыми задают группы). Отдаёт управление циклу событий, чтобы большой пересчёт не вешал сервер.
export async function groupFree(
  free: FreeDet[],
  cent: Map<string, Float32Array>,
  rej: Map<string, Set<string>>,
  T: number,
): Promise<{ toExisting: { det: string; person: string }[]; fresh: { dets: string[] }[] }> {
  const toExisting: { det: string; person: string }[] = [];
  const fresh: { sum: Float32Array; cen: Float32Array; dets: string[] }[] = [];
  let n = 0;
  for (const d of free) {
    if (++n % 200 === 0) await new Promise((r) => setImmediate(r));
    const v = d.v;
    let best = -1, bestP = '';
    for (const [pid, c] of cent) {
      if (c.length !== v.length || rej.get(d.id)?.has(pid)) continue;
      const s = dot(c, v);
      if (s > best) { best = s; bestP = pid; }
    }
    if (best >= T) { toExisting.push({ det: d.id, person: bestP }); continue; }
    let bi = -1, bs = -1;
    fresh.forEach((g, i) => {
      if (g.cen.length !== v.length) return;
      const s = dot(g.cen, v);
      if (s > bs) { bs = s; bi = i; }
    });
    if (bs >= T) {
      const g = fresh[bi];
      for (let i = 0; i < v.length; i++) g.sum[i] += v[i];
      g.cen = Float32Array.from(g.sum);
      normalize(g.cen);
      g.dets.push(d.id);
    } else {
      fresh.push({ sum: Float32Array.from(v), cen: Float32Array.from(v), dets: [d.id] });
    }
  }
  return { toExisting, fresh: fresh.map((g) => ({ dets: g.dets })) };
}

// Для сопоставления слов запроса с именем: «Валей», «Валю», «Вали» это «Валя». Без словаря: сравниваем начало слова.
const norm = (w: string): string => w.toLowerCase().replace(/ё/g, 'е');
export function sameWord(word: string, nameWord: string): boolean {
  const a = norm(word), b = norm(nameWord);
  if (a === b) return true;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i >= 3 && i >= Math.min(a.length, b.length) - 2 && Math.abs(a.length - b.length) <= 3;
}
const STOP = new Set(['фото', 'фотки', 'фотка', 'фотографии', 'фотография', 'снимки', 'снимок', 'картинки', 'с', 'со', 'и', 'где', 'есть', 'покажи', 'найди', 'все', 'всё', 'мне', 'photos', 'with', 'of', 'and', 'show']);

@Injectable()
export class PeopleService {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(MediaSettingsService) private readonly settings: MediaSettingsService,
  ) {}

  // Один пересчёт групп человека за раз: два одновременных создали бы дубли групп.
  private async exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    this.locks.set(key, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === run) this.locks.delete(key);
    }
  }

  // После просмотра новых файлов: пересчитать группы у всех, чьи записи на этих файлах.
  async refreshForBlobs(blobIds: string[]): Promise<void> {
    const r = await this.db.query<{ owner_id: string; kind: string }>(
      `SELECT DISTINCT f.owner_id, CASE WHEN d.kind = 'face' THEN 'person' ELSE 'pet' END AS kind
       FROM detections d JOIN files f ON f.blob_id = d.blob_id WHERE d.blob_id = ANY($1::bigint[])`,
      [blobIds],
    );
    for (const x of r.rows) await this.recluster(x.owner_id, x.kind as PersonKind);
  }

  // У кого есть находки без группы, которых раньше не разбирали (например, человек загрузил уже просмотренный файл): пересчитать.
  // Подпись «сколько находок без группы и какой последний файл» не даёт гонять пересчёт зря, пока ничего не изменилось.
  private readonly seen = new Map<string, string>();

  private async pendingSigs(ownerId?: string): Promise<{ owner: string; kind: PersonKind; sig: string }[]> {
    const r = await this.db.query<{ owner_id: string; kind: PersonKind; n: string; lastf: string }>(
      `SELECT f.owner_id, CASE WHEN d.kind = 'face' THEN 'person' ELSE 'pet' END AS kind, count(DISTINCT d.id) AS n, max(f.id) AS lastf
       FROM files f JOIN detections d ON d.blob_id = f.blob_id
       LEFT JOIN detection_people dp ON dp.detection_id = d.id AND dp.owner_id = f.owner_id
       WHERE dp.detection_id IS NULL AND ($1::bigint IS NULL OR f.owner_id = $1)
       GROUP BY 1, 2`,
      [ownerId ?? null],
    );
    return r.rows.map((x) => ({ owner: x.owner_id, kind: x.kind, sig: `${x.n}/${x.lastf}` }));
  }

  async refreshPending(): Promise<void> {
    for (const p of await this.pendingSigs()) {
      const key = `${p.owner}:${p.kind}`;
      if (this.seen.get(key) === p.sig) continue;
      await this.recluster(p.owner, p.kind);
      const after = (await this.pendingSigs(p.owner)).find((x) => x.kind === p.kind);
      if (after) this.seen.set(key, after.sig);
      else this.seen.delete(key);
    }
  }

  // Сопоставить новые находки с группами человека: сначала с уже существующими (по среднему вектору группы), остальные
  // собрать в новые безымянные группы. Назначения, которые сделал сам человек, и имена не меняются никогда.
  async recluster(ownerId: string, kind: PersonKind): Promise<{ assigned: number; created: number }> {
    return this.exclusive(`${ownerId}:${kind}`, () => this.doRecluster(ownerId, kind));
  }

  // Порог сходства: у лиц его задаёт администратор (процент в настройках), у питомцев он постоянный.
  private async threshold(kind: PersonKind): Promise<number> {
    return kind === 'person' ? (await this.settings.get()).facesSim / 100 : PET_SIM;
  }

  // Средние векторы групп (центры) по списку номеров групп.
  private async centroids(ownerId: string, ids: string[]): Promise<Map<string, Float32Array>> {
    const cent = new Map<string, Float32Array>();
    if (!ids.length) return cent;
    const rows = (
      await this.db.query<{ person_id: string; vector: Buffer }>(
        `SELECT dp.person_id, d.vector FROM detection_people dp JOIN detections d ON d.id = dp.detection_id
         WHERE dp.owner_id = $1 AND dp.person_id = ANY($2::bigint[])`,
        [ownerId, ids],
      )
    ).rows;
    for (const r of rows) {
      const v = f32(r.vector);
      const c = cent.get(r.person_id) ?? new Float32Array(v.length);
      if (c.length === v.length) for (let i = 0; i < v.length; i++) c[i] += v[i];
      cent.set(r.person_id, c);
    }
    for (const c of cent.values()) normalize(c);
    return cent;
  }

  private async rejects(ownerId: string): Promise<Map<string, Set<string>>> {
    const rej = new Map<string, Set<string>>();
    for (const r of (await this.db.query<{ detection_id: string; person_id: string }>('SELECT detection_id, person_id FROM detection_rejects WHERE owner_id = $1', [ownerId])).rows) {
      if (!rej.has(r.detection_id)) rej.set(r.detection_id, new Set());
      rej.get(r.detection_id)!.add(r.person_id);
    }
    return rej;
  }

  private async doRecluster(ownerId: string, kind: PersonKind): Promise<{ assigned: number; created: number }> {
    const T = await this.threshold(kind);
    const kinds = KINDS[kind];
    const people = (await this.db.query<{ id: string }>('SELECT id FROM people WHERE owner_id = $1 AND kind = $2', [ownerId, kind])).rows;
    const cent = await this.centroids(ownerId, people.map((p) => p.id));
    const rej = await this.rejects(ownerId);
    const un = (
      await this.db.query<{ id: string; vector: Buffer; score: number }>(
        `SELECT d.id, d.vector, d.score FROM detections d
         WHERE d.kind = ANY($2::text[]) AND d.blob_id IN (SELECT blob_id FROM files WHERE owner_id = $1 AND blob_id IS NOT NULL)
           AND NOT EXISTS (SELECT 1 FROM detection_people dp WHERE dp.detection_id = d.id AND dp.owner_id = $1)
         ORDER BY d.score DESC, d.id`,
        [ownerId, kinds],
      )
    ).rows;
    const { toExisting, fresh } = await groupFree(un.map((d) => ({ id: d.id, v: f32(d.vector) })), cent, rej, T);
    let assigned = 0, created = 0;
    if (toExisting.length) {
      await this.db.query(
        `INSERT INTO detection_people (detection_id, owner_id, person_id, source)
         SELECT x.det, $1, x.person, 'auto' FROM unnest($2::bigint[], $3::bigint[]) AS x(det, person) ON CONFLICT DO NOTHING`,
        [ownerId, toExisting.map((x) => x.det), toExisting.map((x) => x.person)],
      );
      assigned += toExisting.length;
    }
    for (const g of fresh) {
      if (g.dets.length < MIN_GROUP) continue;
      await this.db.tx(async (c) => {
        const p = await c.query<{ id: string }>('INSERT INTO people (owner_id, kind) VALUES ($1, $2) RETURNING id', [ownerId, kind]);
        await c.query(
          `INSERT INTO detection_people (detection_id, owner_id, person_id, source)
           SELECT x, $1, $2, 'auto' FROM unnest($3::bigint[]) AS x ON CONFLICT DO NOTHING`,
          [ownerId, p.rows[0].id, g.dets],
        );
      });
      created++;
      assigned += g.dets.length;
    }
    return { assigned, created };
  }

  // Что «пересобирается»: безымянные, не скрытые группы людей, в которых никого не назначали вручную. Всё остальное
  // (названные, скрытые, правленные руками) остаётся как есть.
  private static readonly DISPOSABLE = `p.kind = 'person' AND p.name IS NULL AND NOT p.hidden
    AND NOT EXISTS (SELECT 1 FROM detection_people dp WHERE dp.person_id = p.id AND dp.source = 'manual')`;

  private async faceOwners(): Promise<string[]> {
    return (await this.db.query<{ owner_id: string }>(
      `SELECT DISTINCT f.owner_id FROM files f JOIN detections d ON d.blob_id = f.blob_id WHERE d.kind = 'face' AND f.blob_id IS NOT NULL`,
    )).rows.map((r) => r.owner_id);
  }

  // «Пересобрать группы»: у всех безымянных автоматических групп людей стереть состав и собрать лица заново по текущей
  // строгости. Названные, скрытые и правленные вручную группы остаются; к ним лица тоже могут присоединиться.
  async rebuildFaces(): Promise<{ removed: number; created: number; kept: number }> {
    let removed = 0, created = 0, kept = 0;
    for (const owner of await this.faceOwners()) {
      await this.exclusive(`${owner}:person`, async () => {
        const del = await this.db.query(`DELETE FROM people p WHERE p.owner_id = $1 AND ${PeopleService.DISPOSABLE}`, [owner]);
        removed += del.rowCount ?? 0;
        created += (await this.doRecluster(owner, 'person')).created;
        kept += Number((await this.db.query<{ n: string }>("SELECT count(*) AS n FROM people WHERE owner_id = $1 AND kind = 'person'", [owner])).rows[0].n);
      });
    }
    this.seen.clear();
    return { removed, created, kept };
  }

  // Подсказка для настройки: сколько групп людей получилось бы при каждой строгости (только считает, ничего не меняет).
  async hintFaces(): Promise<{ sim: number; groups: number; ungrouped: number }[]> {
    const sims = [30, 35, 40, 45, 50, 55];
    const out = sims.map((sim) => ({ sim, groups: 0, ungrouped: 0 }));
    for (const owner of await this.faceOwners()) {
      const keep = (
        await this.db.query<{ id: string }>(`SELECT p.id FROM people p WHERE p.owner_id = $1 AND p.kind = 'person' AND NOT (${PeopleService.DISPOSABLE})`, [owner])
      ).rows.map((r) => r.id);
      const cent = await this.centroids(owner, keep);
      const free = (
        await this.db.query<{ id: string; vector: Buffer }>(
          `SELECT d.id, d.vector FROM detections d
           WHERE d.kind = 'face' AND d.blob_id IN (SELECT blob_id FROM files WHERE owner_id = $1 AND blob_id IS NOT NULL)
             AND NOT EXISTS (SELECT 1 FROM detection_people dp WHERE dp.detection_id = d.id AND dp.owner_id = $1 AND dp.person_id = ANY($2::bigint[]))
           ORDER BY d.score DESC, d.id`,
          [owner, keep],
        )
      ).rows.map((d) => ({ id: d.id, v: f32(d.vector) }));
      for (const row of out) {
        const { toExisting, fresh } = await groupFree(free, cent, new Map(), row.sim / 100);
        const big = fresh.filter((g) => g.dets.length >= MIN_GROUP);
        row.groups += keep.length + big.length;
        row.ungrouped += free.length - toExisting.length - big.reduce((n, g) => n + g.dets.length, 0);
      }
    }
    return out;
  }

  async status(): Promise<{ faces: boolean; pets: boolean }> {
    const s = await this.settings.get();
    return { faces: s.facesEnabled, pets: s.petsEnabled };
  }

  // withHidden=false: только видимые группы; true: все, включая скрытые (скрытые отличает поле hidden).
  async list(ownerId: string, withHidden: boolean): Promise<PersonInfo[]> {
    const r = await this.db.query<{ id: string; name: string | null; kind: PersonKind; hidden: boolean; n: string; det: string }>(
      `WITH pf AS (
         SELECT p.id, p.name, p.kind, p.hidden, count(DISTINCT f.id) AS n
         FROM people p
         JOIN detection_people dp ON dp.person_id = p.id AND dp.owner_id = p.owner_id
         JOIN detections d ON d.id = dp.detection_id
         JOIN files f ON f.blob_id = d.blob_id AND f.owner_id = p.owner_id AND f.trashed_at IS NULL
         WHERE p.owner_id = $1 AND ($2::boolean OR NOT p.hidden) GROUP BY p.id
       ), cov AS (
         SELECT DISTINCT ON (dp.person_id) dp.person_id, d.id AS det
         FROM detection_people dp JOIN detections d ON d.id = dp.detection_id
         JOIN files f ON f.blob_id = d.blob_id AND f.owner_id = dp.owner_id AND f.trashed_at IS NULL
         WHERE dp.owner_id = $1
         ORDER BY dp.person_id, (dp.source = 'manual') DESC, d.score * d.w * d.h DESC, d.id
       )
       SELECT pf.id, pf.name, pf.kind, pf.hidden, pf.n, cov.det FROM pf JOIN cov ON cov.person_id = pf.id
       ORDER BY (pf.name IS NULL), pf.n DESC, pf.id`,
      [ownerId, withHidden],
    );
    return r.rows.map((x) => ({ id: x.id, name: x.name, kind: x.kind, hidden: x.hidden, count: Number(x.n), cover: x.det }));
  }

  private async person(ownerId: string, id: string): Promise<{ id: string; kind: PersonKind; name: string | null }> {
    if (!ID_RE.test(id)) throw new NotFoundException('Нет такого человека');
    const p = (await this.db.query<{ id: string; kind: PersonKind; name: string | null }>('SELECT id, kind, name FROM people WHERE id = $1 AND owner_id = $2', [id, ownerId])).rows[0];
    if (!p) throw new NotFoundException('Нет такого человека');
    return p;
  }

  // Находка должна быть на файле этого человека, иначе 404 (чужое не показываем и не признаём существующим).
  private async detection(ownerId: string, id: string): Promise<{ id: string; blob_id: string; kind: 'face' | 'cat' | 'dog'; x: number; y: number; w: number; h: number }> {
    if (!ID_RE.test(id)) throw new NotFoundException('Нет такой находки');
    const d = (
      await this.db.query<{ id: string; blob_id: string; kind: 'face' | 'cat' | 'dog'; x: number; y: number; w: number; h: number }>(
        `SELECT d.id, d.blob_id, d.kind, d.x, d.y, d.w, d.h FROM detections d
         WHERE d.id = $1 AND EXISTS (SELECT 1 FROM files f WHERE f.blob_id = d.blob_id AND f.owner_id = $2)`,
        [id, ownerId],
      )
    ).rows[0];
    if (!d) throw new NotFoundException('Нет такой находки');
    return d;
  }

  async rename(ownerId: string, id: string, patch: { name?: string | null; hidden?: boolean }): Promise<void> {
    const p = await this.person(ownerId, id);
    if (patch.name !== undefined) {
      const name = patch.name === null ? null : patch.name.trim().replace(/\s+/g, ' ');
      if (name !== null && (name.length < 1 || name.length > 60)) throw new BadRequestException('Имя от 1 до 60 символов');
      if (name !== null) {
        const dup = await this.db.query('SELECT 1 FROM people WHERE owner_id = $1 AND lower(name) = lower($2) AND id <> $3 LIMIT 1', [ownerId, name, id]);
        if (dup.rowCount) throw new ConflictException('Такое имя уже есть. Объедините эти две группы в одну.');
      }
      await this.db.query('UPDATE people SET name = $2 WHERE id = $1', [p.id, name]);
    }
    if (patch.hidden !== undefined) await this.db.query('UPDATE people SET hidden = $2 WHERE id = $1', [p.id, patch.hidden]);
  }

  // Объединить: всё из from переходит в into. Имя остаётся у into, а если у него нет, берётся имя from.
  async merge(ownerId: string, intoId: string, fromId: string): Promise<void> {
    const into = await this.person(ownerId, intoId);
    const from = await this.person(ownerId, fromId);
    if (into.id === from.id) throw new BadRequestException('Выберите другую группу');
    if (into.kind !== from.kind) throw new BadRequestException('Человека нельзя объединить с питомцем');
    await this.db.tx(async (c) => {
      await c.query('UPDATE detection_people SET person_id = $1 WHERE person_id = $2 AND owner_id = $3', [into.id, from.id, ownerId]);
      if (into.name === null && from.name !== null) {
        await c.query('UPDATE people SET name = NULL WHERE id = $1', [from.id]); // освободить имя (на случай уникальности)
        await c.query('UPDATE people SET name = $2 WHERE id = $1', [into.id, from.name]);
      }
      await c.query('DELETE FROM people WHERE id = $1', [from.id]); // отказы «это не он» уходят вместе с группой
    });
  }

  // Объединить сразу несколько групп в одну: {from: [...]} переходят в into. Сначала проверяется всё, потом сливается.
  async mergeMany(ownerId: string, intoId: string, fromIds: string[]): Promise<number> {
    const ids = [...new Set(fromIds)].filter((x) => x !== intoId);
    if (ids.length === 0) throw new BadRequestException('Выберите хотя бы две группы');
    if (ids.length > 300) throw new BadRequestException('За раз можно объединить не больше 300 групп');
    const into = await this.person(ownerId, intoId);
    for (const id of ids) {
      if ((await this.person(ownerId, id)).kind !== into.kind) throw new BadRequestException('Человека нельзя объединить с питомцем');
    }
    for (const id of ids) await this.merge(ownerId, intoId, id);
    return ids.length;
  }

  // Распустить группу: находки становятся «ничьими» и при следующем пересчёте могут собраться заново. Чтобы группа не
  // возвращалась, её скрывают, а не удаляют.
  async remove(ownerId: string, id: string): Promise<void> {
    const p = await this.person(ownerId, id);
    await this.db.query('DELETE FROM people WHERE id = $1', [p.id]);
  }

  // «Это не он»: на файле у человека убрать его из группы, и больше туда этот снимок не попадёт.
  async notThem(ownerId: string, personId: string, fileId: string): Promise<number> {
    const p = await this.person(ownerId, personId);
    if (!ID_RE.test(fileId)) throw new NotFoundException('Нет такого файла');
    const r = await this.db.query<{ detection_id: string }>(
      `DELETE FROM detection_people dp USING detections d, files f
       WHERE dp.person_id = $1 AND dp.owner_id = $2 AND d.id = dp.detection_id AND f.id = $3 AND f.owner_id = $2 AND f.blob_id = d.blob_id
       RETURNING dp.detection_id`,
      [p.id, ownerId, fileId],
    );
    if (r.rows.length) {
      await this.db.query(
        'INSERT INTO detection_rejects (detection_id, owner_id, person_id) SELECT x, $1, $2 FROM unnest($3::bigint[]) AS x ON CONFLICT DO NOTHING',
        [ownerId, p.id, r.rows.map((x) => x.detection_id)],
      );
    }
    return r.rows.length;
  }

  // Назначить находку человеку (personId) или снять назначение (null). Это ручной выбор: пересчёт его не трогает.
  async assign(ownerId: string, detectionId: string, personId: string | null): Promise<void> {
    const d = await this.detection(ownerId, detectionId);
    if (personId === null) {
      await this.db.query('DELETE FROM detection_people WHERE detection_id = $1 AND owner_id = $2', [d.id, ownerId]);
      return;
    }
    const p = await this.person(ownerId, personId);
    if ((d.kind === 'face') !== (p.kind === 'person')) throw new BadRequestException('Лицо можно отнести только к человеку, а питомца только к питомцу');
    await this.db.tx(async (c) => {
      await c.query(
        `INSERT INTO detection_people (detection_id, owner_id, person_id, source) VALUES ($1,$2,$3,'manual')
         ON CONFLICT (detection_id, owner_id) DO UPDATE SET person_id = EXCLUDED.person_id, source = 'manual'`,
        [d.id, ownerId, p.id],
      );
      await c.query('DELETE FROM detection_rejects WHERE detection_id = $1 AND owner_id = $2 AND person_id = $3', [d.id, ownerId, p.id]);
    });
    void this.recluster(ownerId, p.kind).catch(() => undefined); // теперь у группы есть эталон: подтянуть похожие находки
  }

  // Завести человека (или питомца) по находке на фото и сразу назвать его.
  async createFromDetection(ownerId: string, detectionId: string, nameIn: string): Promise<{ id: string }> {
    const d = await this.detection(ownerId, detectionId);
    const name = nameIn.trim().replace(/\s+/g, ' ');
    if (name.length < 1 || name.length > 60) throw new BadRequestException('Имя от 1 до 60 символов');
    const kind: PersonKind = d.kind === 'face' ? 'person' : 'pet';
    const same = (await this.db.query<{ id: string }>('SELECT id FROM people WHERE owner_id = $1 AND lower(name) = lower($2)', [ownerId, name])).rows[0];
    if (same) {
      await this.assign(ownerId, d.id, same.id); // имя уже есть: это та же группа
      return { id: same.id };
    }
    const id = await this.db.tx(async (c) => {
      const p = await c.query<{ id: string }>('INSERT INTO people (owner_id, kind, name) VALUES ($1,$2,$3) RETURNING id', [ownerId, kind, name]);
      await c.query(
        `INSERT INTO detection_people (detection_id, owner_id, person_id, source) VALUES ($1,$2,$3,'manual')
         ON CONFLICT (detection_id, owner_id) DO UPDATE SET person_id = EXCLUDED.person_id, source = 'manual'`,
        [d.id, ownerId, p.rows[0].id],
      );
      return p.rows[0].id;
    });
    void this.recluster(ownerId, kind).catch(() => undefined);
    return { id };
  }

  // Файлы человека, на которых есть ВСЕ перечисленные люди и питомцы, сначала новые.
  async filesWithAll(ownerId: string, personIds: string[], limit: number): Promise<FileRow[]> {
    const ids = personIds.filter((x) => ID_RE.test(x));
    if (ids.length === 0) return [];
    const params: unknown[] = [ownerId];
    let where = 'f.owner_id = $1 AND f.trashed_at IS NULL AND f.blob_id IS NOT NULL';
    for (const id of ids) {
      params.push(id);
      where += ` AND EXISTS (SELECT 1 FROM detections d JOIN detection_people dp ON dp.detection_id = d.id AND dp.owner_id = $1 JOIN people pp ON pp.id = dp.person_id AND pp.owner_id = $1 WHERE d.blob_id = f.blob_id AND dp.person_id = $${params.length})`;
    }
    params.push(limit);
    return (await this.db.query<FileRow>(`SELECT f.* FROM files f WHERE ${where} ORDER BY f.taken_at DESC, f.id DESC LIMIT $${params.length}`, params)).rows;
  }

  async names(ownerId: string, ids: string[]): Promise<{ id: string; name: string }[]> {
    if (ids.length === 0) return [];
    return (await this.db.query<{ id: string; name: string }>('SELECT id, name FROM people WHERE owner_id = $1 AND id = ANY($2::bigint[]) AND name IS NOT NULL', [ownerId, ids])).rows;
  }

  async facesOfFile(ownerId: string, fileId: string): Promise<FileFace[]> {
    if (!ID_RE.test(fileId)) return [];
    const r = await this.db.query<{ id: string; kind: 'face' | 'cat' | 'dog'; x: number; y: number; w: number; h: number; person_id: string | null; name: string | null }>(
      `SELECT d.id, d.kind, d.x, d.y, d.w, d.h, dp.person_id, p.name
       FROM files f JOIN detections d ON d.blob_id = f.blob_id
       LEFT JOIN detection_people dp ON dp.detection_id = d.id AND dp.owner_id = f.owner_id
       LEFT JOIN people p ON p.id = dp.person_id
       WHERE f.id = $1 AND f.owner_id = $2 ORDER BY d.x, d.id`,
      [fileId, ownerId],
    );
    return r.rows.map((x) => ({ id: x.id, kind: x.kind, box: [x.x, x.y, x.w, x.h], personId: x.person_id, name: x.name }));
  }

  // Обложка: квадратная вырезка лица (или питомца) с запасом вокруг. Строится при первом запросе и кладётся на диск
  // faces/<файл-оригинал>/<находка>.webp; стирается вместе с файлом-оригиналом.
  async cropPath(ownerId: string, detectionId: string): Promise<string> {
    const d = await this.detection(ownerId, detectionId);
    const rel = `faces/${d.blob_id}/${d.id}.webp`;
    try {
      await stat(this.storage.abs(rel));
      return rel;
    } catch {
      /* ещё нет */
    }
    const blob = (await this.db.query<{ path: string }>('SELECT path FROM blobs WHERE id = $1', [d.blob_id])).rows[0];
    if (!blob) throw new NotFoundException('Нет такого файла');
    let prep;
    try {
      prep = await prepareScan(this.storage.abs(blob.path));
    } catch {
      throw new NotFoundException('Картинка не читается');
    }
    const { width: W, height: H } = prep;
    const m = d.kind === 'face' ? 0.45 : 0.1; // у лица запас больше: видны волосы и подбородок
    const side = Math.max(d.w * W, d.h * H) * (1 + 2 * m);
    const cx = (d.x + d.w / 2) * W, cy = (d.y + d.h / 2) * H;
    const sq = Math.min(side, W, H);
    const left = Math.round(Math.min(Math.max(0, cx - sq / 2), W - sq));
    const top = Math.round(Math.min(Math.max(0, cy - sq / 2), H - sq));
    const size = Math.max(8, Math.floor(sq));
    const out = this.storage.abs(rel);
    await mkdir(dirname(out), { recursive: true });
    const tmp = `${out}.${process.pid}.tmp`;
    await sharp(prep.jpeg).extract({ left, top, width: Math.min(size, W - left), height: Math.min(size, H - top) }).resize(192, 192, { fit: 'cover' }).webp({ quality: 80 }).toFile(tmp);
    const { rename } = await import('node:fs/promises');
    await rename(tmp, out);
    return rel;
  }

  // Слова запроса, совпавшие с именами людей этого человека, и то, что осталось от запроса («Валя на пляже» -> Валя + «на пляже»).
  async matchNames(ownerId: string, text: string): Promise<{ ids: string[]; rest: string }> {
    const names = (await this.db.query<{ id: string; name: string }>('SELECT id, name FROM people WHERE owner_id = $1 AND name IS NOT NULL', [ownerId])).rows;
    if (names.length === 0) return { ids: [], rest: text };
    const words = text.split(/[\s,.;:!?()"«»]+/).filter(Boolean);
    const ids = new Set<string>();
    const left: string[] = [];
    for (const w of words) {
      const hit = names.filter((p) => p.name.split(/\s+/).some((nw) => sameWord(w, nw)));
      if (hit.length) hit.forEach((p) => ids.add(p.id));
      else left.push(w);
    }
    const rest = left.filter((w) => !STOP.has(norm(w))).join(' ');
    return { ids: [...ids], rest: ids.size ? rest : text };
  }
}
