import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import sharp from 'sharp';
import { DbService } from '../db/db.service';
import { FileRow, hiddenFromLibrary, ID_RE } from './files.service';
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
  hidden: boolean; // скрыто у ЭТОГО человека (личный выбор)
  shared: boolean; // на группе есть фото больше чем одного человека: она общая
  canName: boolean; // можно дать или сменить имя (безымянной — любому, названной — только администратору)
  canMerge: boolean; // можно объединять и распускать (безымянные личные группы — владельцу, остальное — только администратору)
  count: number; // файлов человека (вне корзины), на которых он есть
  cover: string; // id находки для обложки (лицо или питомец)
}

// Долгая операция над группами людей (подсчёт или пересборка), идёт в фоне; админка показывает ход.
export interface FaceJob {
  kind: 'hint' | 'rebuild';
  state: 'running' | 'done' | 'error';
  step: number;
  steps: number;
  text: string; // что делается сейчас
  elapsedSec: number;
  hint?: { sim: number; groups: number; ungrouped: number }[];
  rebuild?: { removed: number; created: number; kept: number };
  error?: string;
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

// ── Профиль человека ──
// Раньше человек был одним средним вектором. Теперь у него несколько эталонов (разные возрасты, очки, ракурсы), свой
// порог и запас до второго по сходству. Сама модель SFace не меняется: «учится» профиль, то есть то, как мы по подписям
// людей решаем, чьё это лицо.
export interface Profile { cen: Float32Array; protos: Float32Array[]; thr: number; n: number }
// Лицо присоединяется к группе автоматически, только если оно похоже на неё заметно больше, чем на следующую по сходству.
export const MARGIN = 0.04;
// Эталон засчитывается чуть строже центра: он описывает редкий вид человека, а не всех.
const PROTO_PENALTY = 0.05;

function centroidOf(vs: Float32Array[]): Float32Array {
  const c = new Float32Array(vs[0].length);
  for (const v of vs) if (v.length === c.length) for (let i = 0; i < c.length; i++) c[i] += v[i];
  normalize(c);
  return c;
}

// Профиль по векторам группы: центр, до 4 эталонов (простая кластеризация k-средних) и порог человека.
// Порог у человека свой: строже у тех, чьи лица почти не отличаются между собой, мягче у тех, кто на фото разный
// (дети, очки), но всегда в пределах от T-0,05 до T+0,08, где T общая строгость из админки.
export function buildProfile(all: Float32Array[], T: number): Profile {
  const n = all.length;
  const cen = centroidOf(all);
  const protos: Float32Array[] = [];
  if (n >= 8) {
    const sample = n > 300 ? all.filter((_, i) => i % Math.ceil(n / 300) === 0) : all;
    const k = Math.min(4, Math.floor(sample.length / 6));
    if (k >= 2) {
      // Начальные центры: самый типичный, дальше каждый раз самый далёкий от уже выбранных.
      let seeds = [sample.reduce((b, v) => (dot(v, cen) > dot(b, cen) ? v : b))];
      while (seeds.length < k) {
        let far = sample[0], farS = 2;
        for (const v of sample) {
          const s = Math.max(...seeds.map((c) => dot(c, v)));
          if (s < farS) { farS = s; far = v; }
        }
        seeds.push(far);
      }
      let groups: Float32Array[][] = [];
      for (let it = 0; it < 6; it++) {
        groups = seeds.map(() => []);
        for (const v of sample) {
          let bi = 0, bs = -2;
          seeds.forEach((c, i) => { const s = dot(c, v); if (s > bs) { bs = s; bi = i; } });
          groups[bi].push(v);
        }
        seeds = groups.map((g, i) => (g.length ? centroidOf(g) : seeds[i]));
      }
      groups.forEach((g, i) => { if (g.length >= 3) protos.push(seeds[i]); });
    }
  }
  let thr = T;
  if (n >= 10) {
    const sims = all.map((v) => dot(cen, v)).sort((a, b) => a - b);
    const p10 = sims[Math.floor(n * 0.1)];
    thr = Math.min(T + 0.08, Math.max(T - 0.05, p10 - 0.1));
  }
  return { cen, protos, thr, n };
}

export function profileScore(p: Profile, v: Float32Array): number {
  if (p.cen.length !== v.length) return -1;
  let s = dot(p.cen, v);
  for (const c of p.protos) if (c.length === v.length) s = Math.max(s, dot(c, v) - PROTO_PENALTY);
  return s;
}

// Разложить свободные находки: к существующим группам (по профилю, а без профилей по центру группы), остальные в новые
// группы. Порядок входа важен (лучшие находки первыми задают группы). Отдаёт управление циклу событий, чтобы большой
// пересчёт не вешал сервер. Если задан profiles, лицо присоединяется к группе только когда оно проходит порог этого
// человека и опережает вторую по сходству группу не меньше чем на MARGIN; сомнительные остаются свободными (их потом
// показывает очередь «Проверить догадки»).
export async function groupFree(
  free: FreeDet[],
  cent: Map<string, Float32Array>,
  rej: Map<string, Set<string>>,
  T: number,
  profiles?: Map<string, Profile>,
): Promise<{ toExisting: { det: string; person: string }[]; fresh: { dets: string[] }[]; unsure: string[] }> {
  const toExisting: { det: string; person: string }[] = [];
  const unsure: string[] = [];
  const fresh: { sum: Float32Array; cen: Float32Array; dets: string[] }[] = [];
  let n = 0;
  for (const d of free) {
    if (++n % 200 === 0) await new Promise((r) => setImmediate(r));
    const v = d.v;
    if (profiles) {
      let best = -2, second = -2, bestP = '', bestThr = T;
      for (const [pid, pr] of profiles) {
        if (rej.get(d.id)?.has(pid)) continue;
        const s = profileScore(pr, v);
        if (s > best) { second = best; best = s; bestP = pid; bestThr = pr.thr; } else if (s > second) second = s;
      }
      if (bestP && best >= bestThr) {
        if (best - second >= MARGIN) toExisting.push({ det: d.id, person: bestP });
        else unsure.push(d.id);
        continue;
      }
    } else {
      let best = -1, bestP = '';
      for (const [pid, c] of cent) {
        if (c.length !== v.length || rej.get(d.id)?.has(pid)) continue;
        const s = dot(c, v);
        if (s > best) { best = s; bestP = pid; }
      }
      if (best >= T) { toExisting.push({ det: d.id, person: bestP }); continue; }
    }
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
  return { toExisting, fresh: fresh.map((g) => ({ dets: g.dets })), unsure };
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

// Видна ли группа p человеку $N: есть ли она хотя бы на одном его файле вне корзины.
const VISIBLE = (u: string): string =>
  `EXISTS (SELECT 1 FROM detection_people vdp JOIN detections vd ON vd.id = vdp.detection_id JOIN files vf ON vf.blob_id = vd.blob_id AND vf.owner_id = ${u} AND vf.trashed_at IS NULL WHERE vdp.person_id = p.id)`;

export interface AdminGroup {
  id: string;
  name: string | null;
  kind: PersonKind;
  count: number; // файлов у всех людей вместе
  owners: string[]; // логины тех, чьи фото в группе
  hiddenBy: number; // скольким людям группа скрыта
  cover: string;
}
export interface AdminFace { id: string; fileId: string; owner: string; source: 'auto' | 'manual'; score: number }
export interface Guess { detectionId: string; fileId: string; personId: string; name: string; sim: number }

@Injectable()
export class PeopleService {
  // Замки общие на весь процесс: у публичного и внутреннего порта свои экземпляры службы, а пересчёт должен быть один за раз.
  private static readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(MediaSettingsService) private readonly settings: MediaSettingsService,
  ) {}

  // Один пересчёт групп за раз: два одновременных создали бы дубли групп.
  private async exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = PeopleService.locks.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    PeopleService.locks.set(key, run);
    try {
      return await run;
    } finally {
      if (PeopleService.locks.get(key) === run) PeopleService.locks.delete(key);
    }
  }

  // После просмотра новых файлов: пересчитать общие группы по тем видам, что нашлись.
  async refreshForBlobs(blobIds: string[]): Promise<void> {
    const r = await this.db.query<{ kind: string }>(
      `SELECT DISTINCT CASE WHEN d.kind = 'face' THEN 'person' ELSE 'pet' END AS kind FROM detections d WHERE d.blob_id = ANY($1::bigint[])`,
      [blobIds],
    );
    for (const x of r.rows) await this.recluster(x.kind as PersonKind);
  }

  // Есть ли находки без группы, которых раньше не разбирали. Подпись «сколько и какая последняя» не даёт гонять пересчёт зря.
  private readonly seen = new Map<string, string>();

  private async pendingSigs(): Promise<{ kind: PersonKind; sig: string }[]> {
    const r = await this.db.query<{ kind: PersonKind; n: string; lastd: string }>(
      `SELECT CASE WHEN d.kind = 'face' THEN 'person' ELSE 'pet' END AS kind, count(*) AS n, max(d.id) AS lastd
       FROM detections d LEFT JOIN detection_people dp ON dp.detection_id = d.id
       WHERE dp.detection_id IS NULL AND NOT d.ignored AND EXISTS (SELECT 1 FROM files f WHERE f.blob_id = d.blob_id)
       GROUP BY 1`,
    );
    return r.rows.map((x) => ({ kind: x.kind, sig: `${x.n}/${x.lastd}` }));
  }

  async refreshPending(): Promise<void> {
    for (const p of await this.pendingSigs()) {
      if (this.seen.get(p.kind) === p.sig) continue;
      await this.recluster(p.kind);
      const after = (await this.pendingSigs()).find((x) => x.kind === p.kind);
      if (after) this.seen.set(p.kind, after.sig);
      else this.seen.delete(p.kind);
    }
  }

  // Пересчёт общих групп: сначала проверить автоматические назначения у названных людей (сомнительные освободить),
  // потом разложить свободные находки по профилям, остальные собрать в новые безымянные группы.
  // Назначения, которые сделал человек, и имена не меняются никогда.
  async recluster(kind: PersonKind): Promise<{ assigned: number; created: number; released: number }> {
    return this.exclusive(`all:${kind}`, () => this.doRecluster(kind));
  }

  // Порог сходства: у лиц его задаёт администратор (процент в настройках), у питомцев он постоянный.
  private async threshold(kind: PersonKind): Promise<number> {
    return kind === 'person' ? (await this.settings.get()).facesSim / 100 : PET_SIM;
  }

  // Векторы групп: для каждой группы список (ручные назначения отдельно: они надёжнее).
  private async vectors(ids: string[]): Promise<Map<string, { manual: Float32Array[]; auto: { det: string; v: Float32Array }[] }>> {
    const out = new Map<string, { manual: Float32Array[]; auto: { det: string; v: Float32Array }[] }>();
    if (!ids.length) return out;
    const rows = (
      await this.db.query<{ person_id: string; detection_id: string; source: 'auto' | 'manual'; vector: Buffer }>(
        `SELECT dp.person_id, dp.detection_id, dp.source, d.vector FROM detection_people dp JOIN detections d ON d.id = dp.detection_id
         WHERE dp.person_id = ANY($1::bigint[])`,
        [ids],
      )
    ).rows;
    for (const r of rows) {
      const e = out.get(r.person_id) ?? { manual: [], auto: [] };
      const v = f32(r.vector);
      if (r.source === 'manual') e.manual.push(v);
      else e.auto.push({ det: r.detection_id, v });
      out.set(r.person_id, e);
    }
    return out;
  }

  // Профили групп: по ручным подписям, а если их мало, по всем назначениям.
  private async profiles(ids: string[], T: number): Promise<Map<string, Profile>> {
    const out = new Map<string, Profile>();
    for (const [pid, e] of await this.vectors(ids)) {
      const base = e.manual.length >= 3 ? e.manual : [...e.manual, ...e.auto.map((a) => a.v)];
      if (base.length) out.set(pid, buildProfile(base, T));
    }
    return out;
  }

  private async rejects(): Promise<Map<string, Set<string>>> {
    const rej = new Map<string, Set<string>>();
    for (const r of (await this.db.query<{ detection_id: string; person_id: string }>('SELECT detection_id, person_id FROM detection_rejects')).rows) {
      if (!rej.has(r.detection_id)) rej.set(r.detection_id, new Set());
      rej.get(r.detection_id)!.add(r.person_id);
    }
    return rej;
  }

  // Проверка назначений: автоматически присоединённые лица у НАЗВАННЫХ людей сверяются с профилем, построенным по подписям.
  // Если лицо заметно не похоже (ниже порога человека минус запас), оно освобождается и ищет себе другое место.
  private async revalidate(kind: PersonKind, T: number): Promise<number> {
    const named = (await this.db.query<{ id: string }>('SELECT id FROM people WHERE kind = $1 AND name IS NOT NULL', [kind])).rows.map((r) => r.id);
    const vecs = await this.vectors(named);
    let released = 0;
    for (const [pid, e] of vecs) {
      if (e.manual.length < 2 || e.auto.length === 0) continue; // без ручных подписей проверять не по чему
      const pr = buildProfile(e.manual, T);
      const bad = e.auto.filter((a) => profileScore(pr, a.v) < pr.thr - 0.06).map((a) => a.det);
      if (!bad.length) continue;
      await this.db.query("DELETE FROM detection_people WHERE person_id = $1 AND source = 'auto' AND detection_id = ANY($2::bigint[])", [pid, bad]);
      released += bad.length;
    }
    return released;
  }

  private async doRecluster(kind: PersonKind): Promise<{ assigned: number; created: number; released: number }> {
    const T = await this.threshold(kind);
    const kinds = KINDS[kind];
    const released = await this.revalidate(kind, T);
    const people = (await this.db.query<{ id: string }>('SELECT id FROM people WHERE kind = $1', [kind])).rows;
    const prof = await this.profiles(people.map((p) => p.id), T);
    const rej = await this.rejects();
    const un = (
      await this.db.query<{ id: string; vector: Buffer }>(
        `SELECT d.id, d.vector FROM detections d
         WHERE d.kind = ANY($1::text[]) AND NOT d.ignored AND EXISTS (SELECT 1 FROM files f WHERE f.blob_id = d.blob_id)
           AND NOT EXISTS (SELECT 1 FROM detection_people dp WHERE dp.detection_id = d.id)
         ORDER BY d.score DESC, d.id`,
        [kinds],
      )
    ).rows;
    const { toExisting, fresh } = await groupFree(un.map((d) => ({ id: d.id, v: f32(d.vector) })), new Map(), rej, T, prof);
    let assigned = 0, created = 0;
    if (toExisting.length) {
      await this.db.query(
        `INSERT INTO detection_people (detection_id, person_id, source)
         SELECT x.det, x.person, 'auto' FROM unnest($1::bigint[], $2::bigint[]) AS x(det, person) ON CONFLICT DO NOTHING`,
        [toExisting.map((x) => x.det), toExisting.map((x) => x.person)],
      );
      assigned += toExisting.length;
    }
    for (const g of fresh) {
      if (g.dets.length < MIN_GROUP) continue;
      await this.db.tx(async (c) => {
        const p = await c.query<{ id: string }>('INSERT INTO people (kind) VALUES ($1) RETURNING id', [kind]);
        await c.query(
          `INSERT INTO detection_people (detection_id, person_id, source)
           SELECT x, $1, 'auto' FROM unnest($2::bigint[]) AS x ON CONFLICT DO NOTHING`,
          [p.rows[0].id, g.dets],
        );
      });
      created++;
      assigned += g.dets.length;
    }
    return { assigned, created, released };
  }

  // Что «пересобирается»: безымянные группы людей, которые никто не скрыл и в которых никого не назначали вручную.
  // Всё остальное (названные, скрытые, правленные руками) остаётся как есть.
  private static readonly DISPOSABLE = `p.kind = 'person' AND p.name IS NULL
    AND NOT EXISTS (SELECT 1 FROM people_hidden ph WHERE ph.person_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM detection_people dp WHERE dp.person_id = p.id AND dp.source = 'manual')`;

  // «Пересобрать группы»: у всех безымянных автоматических групп людей стереть состав и собрать лица заново по текущей
  // строгости. Названные, скрытые и правленные вручную группы остаются; к ним лица тоже могут присоединиться.
  async rebuildFaces(onStep: (done: number, total: number) => void = () => undefined): Promise<{ removed: number; created: number; kept: number }> {
    onStep(0, 1);
    const r = await this.exclusive('all:person', async () => {
      const del = await this.db.query(`DELETE FROM people p WHERE ${PeopleService.DISPOSABLE}`);
      const created = (await this.doRecluster('person')).created;
      const kept = Number((await this.db.query<{ n: string }>("SELECT count(*) AS n FROM people WHERE kind = 'person'")).rows[0].n);
      return { removed: del.rowCount ?? 0, created, kept };
    });
    onStep(1, 1);
    this.seen.clear();
    return r;
  }

  // Подсказка для настройки: сколько групп людей получилось бы при каждой строгости (только считает, ничего не меняет).
  async hintFaces(onStep: (done: number, total: number, sim: number) => void = () => undefined): Promise<{ sim: number; groups: number; ungrouped: number }[]> {
    const sims = [30, 35, 40, 45, 50, 55];
    const out = sims.map((sim) => ({ sim, groups: 0, ungrouped: 0 }));
    onStep(0, sims.length, sims[0]);
    const keep = (await this.db.query<{ id: string }>(`SELECT p.id FROM people p WHERE p.kind = 'person' AND NOT (${PeopleService.DISPOSABLE})`)).rows.map((r) => r.id);
    const cent = new Map<string, Float32Array>();
    for (const [pid, e] of await this.vectors(keep)) {
      const all = [...e.manual, ...e.auto.map((a) => a.v)];
      if (all.length) cent.set(pid, centroidOf(all));
    }
    const free = (
      await this.db.query<{ id: string; vector: Buffer }>(
        `SELECT d.id, d.vector FROM detections d
         WHERE d.kind = 'face' AND NOT d.ignored AND EXISTS (SELECT 1 FROM files f WHERE f.blob_id = d.blob_id)
           AND NOT EXISTS (SELECT 1 FROM detection_people dp WHERE dp.detection_id = d.id AND dp.person_id = ANY($1::bigint[]))
         ORDER BY d.score DESC, d.id`,
        [keep],
      )
    ).rows.map((d) => ({ id: d.id, v: f32(d.vector) }));
    for (const [i, row] of out.entries()) {
      const { toExisting, fresh } = await groupFree(free, cent, new Map(), row.sim / 100);
      const big = fresh.filter((g) => g.dets.length >= MIN_GROUP);
      row.groups = keep.length + big.length;
      row.ungrouped = free.length - toExisting.length - big.reduce((n, g) => n + g.dets.length, 0);
      onStep(i + 1, sims.length, sims[Math.min(i + 1, sims.length - 1)]);
    }
    return out;
  }

  private job: (Omit<FaceJob, 'elapsedSec'> & { startedAt: number; finishedAt: number | null }) | null = null;

  // Состояние последней долгой операции (или null, если с запуска сервера ничего не запускали).
  faceJob(): FaceJob | null {
    const j = this.job;
    if (!j) return null;
    const { startedAt, finishedAt, ...rest } = j;
    return { ...rest, elapsedSec: Math.round(((finishedAt ?? Date.now()) - startedAt) / 1000) };
  }

  // Запустить подсчёт или пересборку в фоне. Одновременно идёт одна операция: вторая получает отказ.
  startFaceJob(kind: 'hint' | 'rebuild'): FaceJob {
    if (this.job?.state === 'running') throw new ConflictException(`Уже идёт ${this.job.kind === 'hint' ? 'подсчёт' : 'пересборка'} групп: дождитесь конца`);
    const job: NonNullable<PeopleService['job']> = { kind, state: 'running', step: 0, steps: 1, text: 'Подготовка', startedAt: Date.now(), finishedAt: null };
    this.job = job;
    const run = kind === 'hint'
      ? this.hintFaces((done, total, sim) => { job.step = done; job.steps = total; job.text = `Считаю при строгости ${(sim / 100).toFixed(2).replace('.', ',')}`; }).then((rows) => { job.hint = rows; })
      : this.rebuildFaces((done, total) => { job.step = done; job.steps = total; job.text = done < total ? 'Собираю заново группы людей' : 'Готово'; }).then((r) => { job.rebuild = r; });
    void run
      .then(() => { job.state = 'done'; job.step = job.steps; job.text = 'Готово'; })
      .catch((e: unknown) => { job.state = 'error'; job.error = e instanceof Error ? e.message : 'Неизвестная ошибка'; job.text = 'Не получилось'; })
      .finally(() => { job.finishedAt = Date.now(); });
    return this.faceJob()!;
  }

  async status(): Promise<{ faces: boolean; pets: boolean }> {
    const s = await this.settings.get();
    return { faces: s.facesEnabled, pets: s.petsEnabled };
  }

  // Какие из групп общие: на них есть фото больше чем одного человека (вне корзины).
  private async sharedSet(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const r = await this.db.query<{ person_id: string }>(
      `SELECT dp.person_id FROM detection_people dp JOIN detections d ON d.id = dp.detection_id
       JOIN files f ON f.blob_id = d.blob_id AND f.trashed_at IS NULL
       WHERE dp.person_id = ANY($1::bigint[]) GROUP BY dp.person_id HAVING count(DISTINCT f.owner_id) > 1`,
      [ids],
    );
    return new Set(r.rows.map((x) => x.person_id));
  }

  // withHidden=false: только не скрытые у этого человека; true: все (скрытые отличает поле hidden).
  // В списке только те, кто есть на файлах самого человека.
  async list(userId: string, withHidden: boolean, isAdmin = false): Promise<PersonInfo[]> {
    const r = await this.db.query<{ id: string; name: string | null; kind: PersonKind; hidden: boolean; n: string; det: string }>(
      `WITH pf AS (
         SELECT p.id, p.name, p.kind, (ph.user_id IS NOT NULL) AS hidden, count(DISTINCT f.id) AS n
         FROM people p
         JOIN detection_people dp ON dp.person_id = p.id
         JOIN detections d ON d.id = dp.detection_id
         JOIN files f ON f.blob_id = d.blob_id AND f.owner_id = $1 AND f.trashed_at IS NULL
         LEFT JOIN people_hidden ph ON ph.person_id = p.id AND ph.user_id = $1
         WHERE ($2::boolean OR ph.user_id IS NULL) GROUP BY p.id, ph.user_id
       ), cov AS (
         SELECT DISTINCT ON (dp.person_id) dp.person_id, d.id AS det
         FROM detection_people dp JOIN detections d ON d.id = dp.detection_id
         JOIN people pc ON pc.id = dp.person_id
         JOIN files f ON f.blob_id = d.blob_id AND f.owner_id = $1 AND f.trashed_at IS NULL
         ORDER BY dp.person_id, (pc.cover_det = d.id) DESC NULLS LAST, (dp.source = 'manual') DESC, d.score * d.w * d.h DESC, d.id
       )
       SELECT pf.id, pf.name, pf.kind, pf.hidden, pf.n, cov.det FROM pf JOIN cov ON cov.person_id = pf.id
       ORDER BY (pf.name IS NULL), pf.n DESC, pf.id`,
      [userId, withHidden],
    );
    const shared = await this.sharedSet(r.rows.map((x) => x.id));
    return r.rows.map((x) => ({
      id: x.id, name: x.name, kind: x.kind, hidden: x.hidden, count: Number(x.n), cover: x.det,
      shared: shared.has(x.id),
      canName: isAdmin || x.name === null,
      canMerge: isAdmin || (x.name === null && !shared.has(x.id)),
    }));
  }

  // Группа должна быть видна человеку (есть на его файле); администратору видны все. Иначе 404.
  private async person(userId: string, id: string, isAdmin = false): Promise<{ id: string; kind: PersonKind; name: string | null; shared: boolean }> {
    if (!ID_RE.test(id)) throw new NotFoundException('Нет такого человека');
    const p = (
      await this.db.query<{ id: string; kind: PersonKind; name: string | null }>(
        `SELECT p.id, p.kind, p.name FROM people p WHERE p.id = $1 AND ($3::boolean OR ${VISIBLE('$2')})`,
        [id, userId, isAdmin],
      )
    ).rows[0];
    if (!p) throw new NotFoundException('Нет такого человека');
    return { ...p, shared: (await this.sharedSet([p.id])).has(p.id) };
  }

  // Находка должна быть на файле этого человека (администратору годится любая), иначе 404.
  private async detection(userId: string, id: string, isAdmin = false): Promise<{ id: string; blob_id: string; kind: 'face' | 'cat' | 'dog'; x: number; y: number; w: number; h: number }> {
    if (!ID_RE.test(id)) throw new NotFoundException('Нет такой находки');
    const d = (
      await this.db.query<{ id: string; blob_id: string; kind: 'face' | 'cat' | 'dog'; x: number; y: number; w: number; h: number }>(
        `SELECT d.id, d.blob_id, d.kind, d.x, d.y, d.w, d.h FROM detections d
         WHERE d.id = $1 AND ($3::boolean OR EXISTS (SELECT 1 FROM files f WHERE f.blob_id = d.blob_id AND f.owner_id = $2))`,
        [id, userId, isAdmin],
      )
    ).rows[0];
    if (!d) throw new NotFoundException('Нет такой находки');
    return d;
  }

  // Обложка группы: лицо этого человека на выбранном фото. fileId = null: вернуть автоматический выбор.
  // Обложка одна на всех, поэтому её меняют только те, кто вправе менять группу.
  async setCover(userId: string, id: string, fileId: string | null, isAdmin = false): Promise<void> {
    const p = await this.person(userId, id, isAdmin);
    if (!isAdmin && (p.name !== null || p.shared)) throw new ForbiddenException('Обложку общей или названной группы меняет только администратор');
    if (fileId === null) {
      await this.db.query('UPDATE people SET cover_det = NULL WHERE id = $1', [p.id]);
      return;
    }
    if (!ID_RE.test(fileId)) throw new NotFoundException('Файл не найден');
    const d = (
      await this.db.query<{ id: string }>(
        `SELECT d.id FROM files f JOIN detections d ON d.blob_id = f.blob_id
         JOIN detection_people dp ON dp.detection_id = d.id AND dp.person_id = $3
         WHERE f.id = $2 AND ($4::boolean OR f.owner_id = $1) AND f.trashed_at IS NULL
         ORDER BY d.score * d.w * d.h DESC, d.id LIMIT 1`,
        [userId, fileId, p.id, isAdmin],
      )
    ).rows[0];
    if (!d) throw new NotFoundException('На этом фото этого человека нет');
    await this.db.query('UPDATE people SET cover_det = $2 WHERE id = $1', [p.id, d.id]);
  }

  // Имя: безымянной группе его даёт любой, у кого она есть; сменить или стереть имя может только администратор.
  // Скрыть группу может каждый, но только у себя.
  async rename(userId: string, id: string, patch: { name?: string | null; hidden?: boolean }, isAdmin = false): Promise<void> {
    const p = await this.person(userId, id, isAdmin);
    if (patch.name !== undefined) {
      if (p.name !== null && !isAdmin) throw new ForbiddenException('Переименовать уже названную группу может только администратор');
      const name = patch.name === null ? null : patch.name.trim().replace(/\s+/g, ' ');
      if (name === null && !isAdmin) throw new BadRequestException('Имя от 1 до 60 символов');
      if (name !== null && (name.length < 1 || name.length > 60)) throw new BadRequestException('Имя от 1 до 60 символов');
      if (name !== null) {
        const dup = await this.db.query('SELECT 1 FROM people WHERE kind = $3 AND lower(name) = lower($1) AND id <> $2 LIMIT 1', [name, id, p.kind]);
        if (dup.rowCount) throw new ConflictException('Такое имя уже есть. Отнесите лица к нему по одному кнопкой «Это он» или попросите администратора объединить группы.');
      }
      await this.db.query('UPDATE people SET name = $2 WHERE id = $1', [p.id, name]);
    }
    if (patch.hidden !== undefined) {
      if (patch.hidden) await this.db.query('INSERT INTO people_hidden (user_id, person_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, p.id]);
      else await this.db.query('DELETE FROM people_hidden WHERE user_id = $1 AND person_id = $2', [userId, p.id]);
    }
  }

  // Объединять и распускать могут: администратор (любые группы) и обычный человек (только безымянные группы, на которых
  // фото одного человека, то есть его собственные).
  private canMerge(p: { name: string | null; shared: boolean }, isAdmin: boolean): boolean {
    return isAdmin || (p.name === null && !p.shared);
  }

  // Объединить: всё из from переходит в into. Имя остаётся у into, а если у него нет, берётся имя from.
  async merge(userId: string, intoId: string, fromId: string, isAdmin = false): Promise<void> {
    const into = await this.person(userId, intoId, isAdmin);
    const from = await this.person(userId, fromId, isAdmin);
    if (into.id === from.id) throw new BadRequestException('Выберите другую группу');
    if (into.kind !== from.kind) throw new BadRequestException('Человека нельзя объединить с питомцем');
    if (!this.canMerge(into, isAdmin) || !this.canMerge(from, isAdmin)) throw new ForbiddenException('Объединять названные и общие группы может только администратор');
    await this.db.tx(async (c) => {
      await c.query('UPDATE detection_people SET person_id = $1 WHERE person_id = $2', [into.id, from.id]);
      await c.query(
        'INSERT INTO people_hidden (user_id, person_id) SELECT user_id, $1 FROM people_hidden WHERE person_id = $2 ON CONFLICT DO NOTHING',
        [into.id, from.id],
      );
      if (into.name === null && from.name !== null) {
        await c.query('UPDATE people SET name = NULL WHERE id = $1', [from.id]); // освободить имя (уникально)
        await c.query('UPDATE people SET name = $2 WHERE id = $1', [into.id, from.name]);
      }
      await c.query('DELETE FROM people WHERE id = $1', [from.id]); // отказы «это не он» уходят вместе с группой
    });
  }

  // Объединить сразу несколько групп в одну: {from: [...]} переходят в into. Сначала проверяется всё, потом сливается.
  async mergeMany(userId: string, intoId: string, fromIds: string[], isAdmin = false): Promise<number> {
    const ids = [...new Set(fromIds)].filter((x) => x !== intoId);
    if (ids.length === 0) throw new BadRequestException('Выберите хотя бы две группы');
    if (ids.length > 300) throw new BadRequestException('За раз можно объединить не больше 300 групп');
    const into = await this.person(userId, intoId, isAdmin);
    if (!this.canMerge(into, isAdmin)) throw new ForbiddenException('Объединять названные и общие группы может только администратор');
    for (const id of ids) {
      const f = await this.person(userId, id, isAdmin);
      if (f.kind !== into.kind) throw new BadRequestException('Человека нельзя объединить с питомцем');
      if (!this.canMerge(f, isAdmin)) throw new ForbiddenException('Объединять названные и общие группы может только администратор');
    }
    for (const id of ids) await this.merge(userId, intoId, id, isAdmin);
    return ids.length;
  }

  // Распустить группу: находки становятся «ничьими» и при следующем пересчёте могут собраться заново.
  async remove(userId: string, id: string, isAdmin = false): Promise<void> {
    const p = await this.person(userId, id, isAdmin);
    if (!this.canMerge(p, isAdmin)) throw new ForbiddenException('Удалять названные и общие группы может только администратор');
    await this.db.query('DELETE FROM people WHERE id = $1', [p.id]);
  }

  private async rejectDets(personId: string, dets: string[]): Promise<void> {
    if (!dets.length) return;
    await this.db.query('INSERT INTO detection_rejects (detection_id, person_id) SELECT x, $1 FROM unnest($2::bigint[]) AS x ON CONFLICT DO NOTHING', [personId, dets]);
  }

  // «Это не он»: на файле (из СВОИХ файлов) убрать человека из группы; больше этот снимок туда не попадёт. Любой может.
  async notThem(userId: string, personId: string, fileId: string): Promise<number> {
    return this.notThemMany(userId, personId, [fileId]);
  }

  // То же для многих файлов сразу («Убрать из группы» при выборе на странице человека). Возвращает, на скольких файлах группа убрана.
  async notThemMany(userId: string, personId: string, fileIds: unknown): Promise<number> {
    const p = await this.person(userId, personId);
    if (!Array.isArray(fileIds) || fileIds.length < 1 || fileIds.length > 1000 || fileIds.some((x) => typeof x !== 'string' || !ID_RE.test(x))) {
      throw new BadRequestException('fileIds: список от 1 до 1000 номеров файлов');
    }
    const r = await this.db.query<{ detection_id: string; file_id: string }>(
      `DELETE FROM detection_people dp USING detections d, files f
       WHERE dp.person_id = $1 AND d.id = dp.detection_id AND f.id = ANY($3::bigint[]) AND f.owner_id = $2 AND f.blob_id = d.blob_id
       RETURNING dp.detection_id, f.id AS file_id`,
      [p.id, userId, fileIds],
    );
    await this.rejectDets(p.id, r.rows.map((x) => x.detection_id));
    if (r.rows.length) void this.recluster(p.kind).catch(() => undefined); // освобождённые лица могут найти другое место
    return new Set(r.rows.map((x) => x.file_id)).size;
  }

  // «Не он» для одной находки (очередь «Проверить догадки»): эта находка в эту группу больше не пойдёт.
  async rejectDetection(userId: string, detectionId: string, personId: string): Promise<void> {
    const d = await this.detection(userId, detectionId);
    const p = await this.person(userId, personId, true);
    await this.db.query('DELETE FROM detection_people WHERE detection_id = $1 AND person_id = $2', [d.id, p.id]);
    await this.rejectDets(p.id, [d.id]);
  }

  // «Не знаю, кто это» в очереди догадок: эта находка больше не спрашивается у этого человека.
  async skipDetection(userId: string, detectionId: string): Promise<void> {
    const d = await this.detection(userId, detectionId);
    await this.db.query('INSERT INTO face_skips (user_id, detection_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, d.id]);
  }

  // «Это не человек» (кот или собака, принятые за лицо): находка больше не спрашивается и не попадает в группы.
  // Если на фото есть найденный питомец, его можно назвать обычным образом. ignored=false возвращает находку.
  async setIgnored(userId: string, detectionId: string, ignored: boolean): Promise<{ petsEnabled: boolean; petsOnFile: boolean }> {
    const d = await this.detection(userId, detectionId);
    if (d.kind !== 'face') throw new BadRequestException('Так можно отметить только лицо');
    await this.db.tx(async (c) => {
      await c.query('UPDATE detections SET ignored = $2 WHERE id = $1', [d.id, ignored]);
      if (ignored) await c.query('DELETE FROM detection_people WHERE detection_id = $1', [d.id]);
    });
    if (!ignored) void this.recluster('person').catch(() => undefined);
    const pets = Number((await this.db.query<{ n: string }>("SELECT count(*) AS n FROM detections WHERE blob_id = $1 AND kind IN ('cat','dog')", [d.blob_id])).rows[0].n);
    return { petsEnabled: (await this.settings.get()).petsEnabled, petsOnFile: pets > 0 };
  }

  // Назначить находку человеку (personId) или снять назначение (null). Это ручной выбор: пересчёт его не трогает.
  async assign(userId: string, detectionId: string, personId: string | null): Promise<void> {
    const d = await this.detection(userId, detectionId);
    if (personId === null) {
      await this.db.query('DELETE FROM detection_people WHERE detection_id = $1', [d.id]);
      return;
    }
    const p = await this.person(userId, personId, true); // имя общее: подписать можно и того, кого ещё нет на своих фото
    if ((d.kind === 'face') !== (p.kind === 'person')) throw new BadRequestException('Лицо можно отнести только к человеку, а питомца только к питомцу');
    await this.db.tx(async (c) => {
      await c.query(
        `INSERT INTO detection_people (detection_id, person_id, source) VALUES ($1,$2,'manual')
         ON CONFLICT (detection_id) DO UPDATE SET person_id = EXCLUDED.person_id, source = 'manual'`,
        [d.id, p.id],
      );
      await c.query('DELETE FROM detection_rejects WHERE detection_id = $1 AND person_id = $2', [d.id, p.id]);
    });
    void this.recluster(p.kind).catch(() => undefined); // теперь у группы новый эталон: подтянуть похожие, проверить сомнительные
  }

  // Завести человека (или питомца) по находке на фото и сразу назвать его. Имя общее: если такое уже есть, это та же группа.
  async createFromDetection(userId: string, detectionId: string, nameIn: string): Promise<{ id: string }> {
    const d = await this.detection(userId, detectionId);
    const name = nameIn.trim().replace(/\s+/g, ' ');
    if (name.length < 1 || name.length > 60) throw new BadRequestException('Имя от 1 до 60 символов');
    const kind: PersonKind = d.kind === 'face' ? 'person' : 'pet';
    const same = (await this.db.query<{ id: string }>('SELECT id FROM people WHERE kind = $1 AND lower(name) = lower($2)', [kind, name])).rows[0];
    if (same) {
      await this.assign(userId, d.id, same.id);
      return { id: same.id };
    }
    const id = await this.db.tx(async (c) => {
      const p = await c.query<{ id: string }>('INSERT INTO people (kind, name) VALUES ($1,$2) RETURNING id', [kind, name]);
      await c.query(
        `INSERT INTO detection_people (detection_id, person_id, source) VALUES ($1,$2,'manual')
         ON CONFLICT (detection_id) DO UPDATE SET person_id = EXCLUDED.person_id, source = 'manual'`,
        [d.id, p.rows[0].id],
      );
      return p.rows[0].id;
    });
    void this.recluster(kind).catch(() => undefined);
    return { id };
  }

  // «Проверить догадки»: свободные лица на файлах человека, похожие на названного человека, но не настолько, чтобы
  // присоединить само (или слишком близкие к двум людям сразу). Сначала самые похожие.
  async guesses(userId: string, limit: number): Promise<Guess[]> {
    const T = await this.threshold('person');
    const named = (await this.db.query<{ id: string; name: string }>("SELECT id, name FROM people WHERE kind = 'person' AND name IS NOT NULL")).rows;
    if (!named.length) return [];
    const prof = await this.profiles(named.map((p) => p.id), T);
    const rej = await this.rejects();
    const rows = (
      await this.db.query<{ id: string; file_id: string; vector: Buffer }>(
        `SELECT DISTINCT ON (d.id) d.id, f.id AS file_id, d.vector FROM detections d JOIN files f ON f.blob_id = d.blob_id AND f.owner_id = $1 AND f.trashed_at IS NULL
         WHERE d.kind = 'face' AND NOT d.ignored AND NOT EXISTS (SELECT 1 FROM detection_people dp WHERE dp.detection_id = d.id)
           AND NOT EXISTS (SELECT 1 FROM face_skips sk WHERE sk.detection_id = d.id AND sk.user_id = $1)
         ORDER BY d.id DESC LIMIT 5000`,
        [userId],
      )
    ).rows;
    const out: Guess[] = [];
    for (const r of rows) {
      const v = f32(r.vector);
      let best = -2, second = -2, bestP = '';
      for (const [pid, pr] of prof) {
        if (rej.get(r.id)?.has(pid)) continue;
        const s = profileScore(pr, v);
        if (s > best) { second = best; best = s; bestP = pid; } else if (s > second) second = s;
      }
      if (!bestP) continue;
      const thr = prof.get(bestP)!.thr;
      const near = best >= thr - 0.12 && (best < thr || best - second < MARGIN);
      if (near) out.push({ detectionId: r.id, fileId: r.file_id, personId: bestP, name: named.find((p) => p.id === bestP)!.name, sim: Math.round(best * 1000) / 1000 });
    }
    return out.sort((a, b) => b.sim - a.sim).slice(0, limit);
  }

  // ── Для администратора: все группы хранилища ──
  async adminGroups(o: { id?: string; kind?: PersonKind; q?: string; unnamed?: boolean; offset: number; limit: number }): Promise<{ total: number; groups: AdminGroup[] }> {
    const params: unknown[] = [];
    const cond: string[] = [];
    if (o.kind) { params.push(o.kind); cond.push(`p.kind = $${params.length}`); }
    if (o.unnamed) cond.push('p.name IS NULL');
    if (o.id) { params.push(o.id); cond.push(`p.id = $${params.length}`); }
    if (o.q) { params.push(`%${o.q.replace(/[%_\\]/g, (m) => '\\' + m)}%`); cond.push(`p.name ILIKE $${params.length}`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const total = Number((await this.db.query<{ n: string }>(`SELECT count(*) AS n FROM people p ${where}`, params)).rows[0].n);
    params.push(o.limit, o.offset);
    const r = await this.db.query<{ id: string; name: string | null; kind: PersonKind; n: string; owners: string[] | null; hidden_by: string; det: string | null }>(
      `SELECT p.id, p.name, p.kind,
         (SELECT count(DISTINCT f.id) FROM detection_people dp JOIN detections d ON d.id = dp.detection_id JOIN files f ON f.blob_id = d.blob_id AND f.trashed_at IS NULL WHERE dp.person_id = p.id) AS n,
         (SELECT array_agg(DISTINCT u.login) FROM detection_people dp JOIN detections d ON d.id = dp.detection_id JOIN files f ON f.blob_id = d.blob_id AND f.trashed_at IS NULL JOIN users u ON u.id = f.owner_id WHERE dp.person_id = p.id) AS owners,
         (SELECT count(*) FROM people_hidden h WHERE h.person_id = p.id) AS hidden_by,
         COALESCE(p.cover_det, (SELECT d.id FROM detection_people dp JOIN detections d ON d.id = dp.detection_id WHERE dp.person_id = p.id ORDER BY (dp.source = 'manual') DESC, d.score * d.w * d.h DESC, d.id LIMIT 1)) AS det
       FROM people p ${where} ORDER BY (p.name IS NULL), 4 DESC, p.id LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return {
      total,
      groups: r.rows.filter((x) => x.det).map((x) => ({ id: x.id, name: x.name, kind: x.kind, count: Number(x.n), owners: x.owners ?? [], hiddenBy: Number(x.hidden_by), cover: x.det! })),
    };
  }

  // Лица одной группы для разбора: сначала самые крупные и чёткие. Можно убрать любое («не он»).
  async adminFaces(id: string, limit: number, offset: number): Promise<{ group: AdminGroup; total: number; faces: AdminFace[] }> {
    const p = await this.person('0', id, true);
    const g = (await this.db.query<{ name: string | null }>('SELECT name FROM people WHERE id = $1', [p.id])).rows[0];
    const total = Number((await this.db.query<{ n: string }>('SELECT count(*) AS n FROM detection_people WHERE person_id = $1', [p.id])).rows[0].n);
    const r = await this.db.query<{ id: string; file_id: string; owner: string; source: 'auto' | 'manual'; score: number }>(
      `SELECT DISTINCT ON (d.id) d.id, f.id AS file_id, u.login AS owner, dp.source, d.score
       FROM detection_people dp JOIN detections d ON d.id = dp.detection_id
       JOIN files f ON f.blob_id = d.blob_id JOIN users u ON u.id = f.owner_id
       WHERE dp.person_id = $1 ORDER BY d.id, f.trashed_at NULLS FIRST, f.id`,
      [p.id],
    );
    const sorted = r.rows.sort((a, b) => b.score - a.score || Number(a.id) - Number(b.id)).slice(offset, offset + limit);
    const group = (await this.adminGroups({ id: p.id, offset: 0, limit: 1 })).groups[0];
    return { group: group ?? { id: p.id, name: g.name, kind: p.kind, count: 0, owners: [], hiddenBy: 0, cover: sorted[0]?.id ?? '0' }, total, faces: sorted.map((x) => ({ id: x.id, fileId: x.file_id, owner: x.owner, source: x.source, score: x.score })) };
  }

  // Убрать одно лицо из группы (администратор): оно освобождается и в эту группу больше не вернётся.
  async adminRemoveFace(personId: string, detectionId: string): Promise<void> {
    const p = await this.person('0', personId, true);
    if (!ID_RE.test(detectionId)) throw new NotFoundException('Нет такой находки');
    await this.db.query('DELETE FROM detection_people WHERE detection_id = $1 AND person_id = $2', [detectionId, p.id]);
    await this.rejectDets(p.id, [detectionId]);
    void this.recluster(p.kind).catch(() => undefined);
  }

  // Файлы человека, на которых есть ВСЕ перечисленные люди и питомцы, сначала новые.
  async filesWithAll(ownerId: string, personIds: string[], limit: number): Promise<FileRow[]> {
    const ids = personIds.filter((x) => ID_RE.test(x));
    if (ids.length === 0) return [];
    const params: unknown[] = [ownerId];
    let where = `f.owner_id = $1 AND f.trashed_at IS NULL AND f.blob_id IS NOT NULL AND NOT ${hiddenFromLibrary('f', '$1')}`;
    for (const id of ids) {
      params.push(id);
      where += ` AND EXISTS (SELECT 1 FROM detections d JOIN detection_people dp ON dp.detection_id = d.id WHERE d.blob_id = f.blob_id AND dp.person_id = $${params.length})`;
    }
    params.push(limit);
    return (await this.db.query<FileRow>(`SELECT f.* FROM files f WHERE ${where} ORDER BY f.taken_at DESC, f.id DESC LIMIT $${params.length}`, params)).rows;
  }

  // Файлы по условиям: обязательно есть все из include, и нет ни одного из exclude. Группы только те, что видны человеку.
  // Возвращает общее число и номера (не больше limit, сначала новые).
  async matchFiles(ownerId: string, includeIn: unknown, excludeIn: unknown, limit: number): Promise<{ count: number; ids: string[] }> {
    const clean = (v: unknown, what: string): string[] => {
      if (v === undefined || v === null) return [];
      if (!Array.isArray(v) || v.length > 50 || !v.every((x) => typeof x === 'string' && ID_RE.test(x))) throw new BadRequestException(`${what}: список номеров групп`);
      return [...new Set(v as string[])];
    };
    const inc = clean(includeIn, 'include');
    const exc = clean(excludeIn, 'exclude');
    if (inc.length === 0) throw new BadRequestException('Выберите хотя бы одного, кто обязательно должен быть на фото');
    if (inc.some((x) => exc.includes(x))) throw new BadRequestException('Один и тот же человек не может быть и в «обязательно», и в «не должно быть»');
    const own = await this.db.query<{ n: string }>(`SELECT count(*) AS n FROM people p WHERE p.id = ANY($2::bigint[]) AND ${VISIBLE('$1')}`, [ownerId, [...inc, ...exc]]);
    if (Number(own.rows[0].n) !== inc.length + exc.length) throw new NotFoundException('Такой группы нет');
    const has = (param: string) => `EXISTS (SELECT 1 FROM detections d JOIN detection_people dp ON dp.detection_id = d.id WHERE d.blob_id = f.blob_id AND dp.person_id = ${param})`;
    const params: unknown[] = [ownerId];
    let where = `f.owner_id = $1 AND f.trashed_at IS NULL AND f.blob_id IS NOT NULL AND NOT ${hiddenFromLibrary('f', '$1')}`;
    for (const id of inc) { params.push(id); where += ` AND ${has(`$${params.length}`)}`; }
    for (const id of exc) { params.push(id); where += ` AND NOT ${has(`$${params.length}`)}`; }
    const total = Number((await this.db.query<{ n: string }>(`SELECT count(*) AS n FROM files f WHERE ${where}`, params)).rows[0].n);
    params.push(limit);
    const r = await this.db.query<{ id: string }>(`SELECT f.id FROM files f WHERE ${where} ORDER BY f.taken_at DESC, f.id DESC LIMIT $${params.length}`, params);
    return { count: total, ids: r.rows.map((x) => x.id) };
  }

  async names(ownerId: string, ids: string[]): Promise<{ id: string; name: string }[]> {
    if (ids.length === 0) return [];
    return (await this.db.query<{ id: string; name: string }>(`SELECT p.id, p.name FROM people p WHERE p.id = ANY($2::bigint[]) AND p.name IS NOT NULL AND ${VISIBLE('$1')}`, [ownerId, ids])).rows;
  }

  async facesOfFile(ownerId: string, fileId: string): Promise<FileFace[]> {
    if (!ID_RE.test(fileId)) return [];
    const r = await this.db.query<{ id: string; kind: 'face' | 'cat' | 'dog'; x: number; y: number; w: number; h: number; person_id: string | null; name: string | null }>(
      `SELECT d.id, d.kind, d.x, d.y, d.w, d.h, dp.person_id, p.name
       FROM files f JOIN detections d ON d.blob_id = f.blob_id
       LEFT JOIN detection_people dp ON dp.detection_id = d.id
       LEFT JOIN people p ON p.id = dp.person_id
       WHERE f.id = $1 AND f.owner_id = $2 AND NOT d.ignored ORDER BY d.x, d.id`,
      [fileId, ownerId],
    );
    return r.rows.map((x) => ({ id: x.id, kind: x.kind, box: [x.x, x.y, x.w, x.h], personId: x.person_id, name: x.name }));
  }

  // Обложка: квадратная вырезка лица (или питомца) с запасом вокруг. Строится при первом запросе и кладётся на диск
  // faces/<файл-оригинал>/<находка>.webp; стирается вместе с файлом-оригиналом.
  async cropPath(ownerId: string, detectionId: string, isAdmin = false): Promise<string> {
    const d = await this.detection(ownerId, detectionId, isAdmin);
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

  // Слова запроса, совпавшие с именами людей, которые есть на файлах этого человека, и то, что осталось от запроса
  // («Валя на пляже» -> Валя + «на пляже»).
  async matchNames(ownerId: string, text: string): Promise<{ ids: string[]; rest: string }> {
    const names = (await this.db.query<{ id: string; name: string }>(`SELECT p.id, p.name FROM people p WHERE p.name IS NOT NULL AND ${VISIBLE('$1')}`, [ownerId])).rows;
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
