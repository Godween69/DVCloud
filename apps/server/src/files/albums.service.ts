import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { stat } from 'node:fs/promises';
import { DbService } from '../db/db.service';
import { FileRow, hiddenFromLibrary, ID_RE } from './files.service';
import { cleanFileName, withSuffix } from './names';
import { StorageService } from './storage.service';
import { openFile, ZipEntry } from './zip';

export interface PublicAlbum {
  id: string;
  name: string;
  count: number;
  coverFileId: string | null;
  createdAt: string;
  mine: boolean; // false: альбом чужой, им поделились
  ownerName: string | null; // у чужого альбома: кто поделился
  sharedWith: number; // у своего альбома: со сколькими людьми он общий
  // Где файлы альбома видны в ленте (внутри самого альбома они видны всегда). Относится к своим альбомам.
  show: AlbumShow;
  // Тип альбома: 'any' универсальный, иначе принимает только фото, только видео или только скриншоты. Выбирается при создании.
  kind: AlbumKind;
  favorite: boolean; // звёздочка владельца: избранные альбомы идут первыми
}

export interface AlbumSuggestion {
  id: string; // начало события в миллисекундах: им предложение и принимается, и отклоняется
  start: string;
  end: string;
  count: number;
  name: string; // название по умолчанию: даты события
  coverFileId: string;
  fileIds: string[];
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
// «12 июня 2026», «12–15 июня 2026», «28 июня – 2 июля 2026» (дни по времени сервера DVCLOUD_TZ, по умолчанию Москва).
export function eventName(fromMs: number, toMs: number): string {
  const tz = process.env.DVCLOUD_TZ || 'Europe/Moscow';
  const part = (ms: number) => {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'numeric', year: 'numeric' }).formatToParts(new Date(ms));
    const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
    return { d: g('day'), m: g('month'), y: g('year') };
  };
  const a = part(fromMs), b = part(toMs);
  if (a.y === b.y && a.m === b.m && a.d === b.d) return `${a.d} ${MONTHS[a.m - 1]} ${a.y}`;
  if (a.y === b.y && a.m === b.m) return `${a.d}–${b.d} ${MONTHS[a.m - 1]} ${a.y}`;
  if (a.y === b.y) return `${a.d} ${MONTHS[a.m - 1]} – ${b.d} ${MONTHS[b.m - 1]} ${a.y}`;
  return `${a.d} ${MONTHS[a.m - 1]} ${a.y} – ${b.d} ${MONTHS[b.m - 1]} ${b.y}`;
}

export type AlbumKind = 'any' | 'photos' | 'videos' | 'screenshots';
export const ALBUM_KINDS: AlbumKind[] = ['any', 'photos', 'videos', 'screenshots'];

// Какие файлы подходят альбому такого типа (условие к таблице files). Скриншот: ручная отметка сильнее автоматики.
const SHOT = 'COALESCE(f.shot_override, EXISTS (SELECT 1 FROM file_fingerprints p WHERE p.file_id = f.id AND p.screenshot))';
export const KIND_SQL: Record<AlbumKind, string> = {
  any: 'true',
  photos: `f.mime LIKE 'image/%' AND NOT ${SHOT}`,
  videos: "f.mime LIKE 'video/%'",
  screenshots: `f.mime LIKE 'image/%' AND ${SHOT}`,
};

export interface AlbumShow {
  library: boolean;
  photos: boolean;
  videos: boolean;
  screenshots: boolean;
}

export const SHOW_KEYS: (keyof AlbumShow)[] = ['library', 'photos', 'videos', 'screenshots'];

interface AlbumRow {
  id: string;
  owner_id: string;
  name: string;
  created_at: Date;
  n: string;
  cover: string | null;
  owner_name: string;
  shared_with: string;
  in_library: boolean;
  in_photos: boolean;
  in_videos: boolean;
  in_screenshots: boolean;
  kind: AlbumKind;
  favorite: boolean;
}

export const MAX_IDS = 2000;

export function cleanAlbumName(raw: unknown): string {
  if (typeof raw !== 'string') throw new BadRequestException('Поле name: название альбома');
  const s = raw.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length < 1 || s.length > 100) throw new BadRequestException('Название альбома: от 1 до 100 символов');
  return s;
}

// Имя для скачиваемого архива: без символов, опасных в именах файлов.
export function zipFileName(title: string): string {
  const s = title.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '_').replace(/^\.+/, '').trim().slice(0, 80);
  return `${s || 'DV Cloud'}.zip`;
}

export function parseIds(list: unknown): string[] {
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_IDS) throw new BadRequestException(`ids: список от 1 до ${MAX_IDS} номеров`);
  const out = new Set<string>();
  for (const x of list) {
    const v = typeof x === 'number' ? String(x) : x;
    if (typeof v !== 'string' || !ID_RE.test(v)) throw new BadRequestException('ids: неверный номер файла');
    out.add(v);
  }
  return [...out];
}

const toPublic = (r: AlbumRow, viewerId: string): PublicAlbum => {
  const mine = r.owner_id === viewerId;
  return {
    id: r.id,
    name: r.name,
    count: Number(r.n),
    coverFileId: r.cover,
    createdAt: r.created_at.toISOString(),
    mine,
    ownerName: mine ? null : r.owner_name,
    sharedWith: mine ? Number(r.shared_with) : 0,
    show: { library: r.in_library, photos: r.in_photos, videos: r.in_videos, screenshots: r.in_screenshots },
    kind: r.kind,
    favorite: r.favorite,
  };
};

const ALBUM_SELECT = `SELECT a.id, a.owner_id, a.name, a.created_at, u.display_name AS owner_name, a.in_library, a.in_photos, a.in_videos, a.in_screenshots, a.kind, a.favorite,
  (SELECT count(*) FROM album_items ai JOIN files f ON f.id = ai.file_id WHERE ai.album_id = a.id AND f.trashed_at IS NULL) AS n,
  (SELECT f.id FROM album_items ai JOIN files f ON f.id = ai.file_id WHERE ai.album_id = a.id AND f.trashed_at IS NULL ORDER BY f.taken_at DESC, f.id DESC LIMIT 1) AS cover,
  (SELECT count(*) FROM album_shares s WHERE s.album_id = a.id) AS shared_with
  FROM albums a JOIN users u ON u.id = a.owner_id AND a.deleted_at IS NULL`; // удалённые человеком альбомы никому не видны, кроме админа

// Альбом виден хозяину и тем, с кем поделились.
const VISIBLE = `(a.owner_id = $1 OR EXISTS (SELECT 1 FROM album_shares s WHERE s.album_id = a.id AND s.user_id = $1))`;

export interface PublicPerson {
  login: string;
  displayName: string;
}

@Injectable()
export class AlbumsService {
  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
  ) {}

  // Свои альбомы и те, которыми поделились. Свои сначала. Среди своих: избранные, потом по типу (универсальные, фото, видео,
  // скриншоты), потом тяжёлые вперёд (больше файлов), потом по названию.
  async list(userId: string): Promise<PublicAlbum[]> {
    const r = await this.db.query<AlbumRow>(
      `${ALBUM_SELECT} WHERE ${VISIBLE}
       ORDER BY (a.owner_id = $1) DESC, (a.favorite AND a.owner_id = $1) DESC,
         CASE a.kind WHEN 'any' THEN 0 WHEN 'photos' THEN 1 WHEN 'videos' THEN 2 ELSE 3 END,
         n DESC, lower(a.name), a.id`,
      [userId],
    );
    return r.rows.map((x) => toPublic(x, userId));
  }

  // Свой альбом (для изменений). Чужой и несуществующий неотличимы.
  async get(ownerId: string, id: string): Promise<PublicAlbum> {
    if (!ID_RE.test(id)) throw new NotFoundException('Альбом не найден');
    const r = await this.db.query<AlbumRow>(`${ALBUM_SELECT} WHERE a.id = $2 AND a.owner_id = $1`, [ownerId, id]);
    if (!r.rows[0]) throw new NotFoundException('Альбом не найден');
    return toPublic(r.rows[0], ownerId);
  }

  // Альбом для чтения: свой или тот, которым поделились. Возвращает и номер хозяина (его файлы показываем).
  async getVisible(userId: string, id: string): Promise<{ album: PublicAlbum; ownerId: string }> {
    if (!ID_RE.test(id)) throw new NotFoundException('Альбом не найден');
    const r = await this.db.query<AlbumRow>(`${ALBUM_SELECT} WHERE a.id = $2 AND ${VISIBLE}`, [userId, id]);
    if (!r.rows[0]) throw new NotFoundException('Альбом не найден');
    return { album: toPublic(r.rows[0], userId), ownerId: r.rows[0].owner_id };
  }

  async create(ownerId: string, rawName: unknown, rawKind: unknown = 'any'): Promise<PublicAlbum> {
    const name = cleanAlbumName(rawName);
    const kind = rawKind ?? 'any';
    if (typeof kind !== 'string' || !ALBUM_KINDS.includes(kind as AlbumKind)) throw new BadRequestException('Поле kind: any, photos, videos или screenshots');
    try {
      const r = await this.db.query<{ id: string }>('INSERT INTO albums (owner_id, name, kind) VALUES ($1, $2, $3) RETURNING id', [ownerId, name, kind]);
      return this.get(ownerId, r.rows[0].id);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException('Альбом с таким названием уже есть');
      throw e;
    }
  }

  async rename(ownerId: string, id: string, rawName: unknown): Promise<PublicAlbum> {
    await this.get(ownerId, id);
    const name = cleanAlbumName(rawName);
    try {
      await this.db.query('UPDATE albums SET name = $1 WHERE id = $2 AND owner_id = $3', [name, id, ownerId]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException('Альбом с таким названием уже есть');
      throw e;
    }
    return this.get(ownerId, id);
  }

  // Альбом пропадает у человека (и у тех, с кем он был общим), но не стирается: он уходит в «Удалённые альбомы» админа,
  // чтобы нельзя было принять случайно убранные дорогие фото за мусор. Сами фото остаются в библиотеке человека.
  async remove(ownerId: string, id: string): Promise<void> {
    await this.get(ownerId, id);
    await this.db.query('UPDATE albums SET deleted_at = now() WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [id, ownerId]);
  }

  // Где показывать файлы альбома: частичное изменение допусков. Переданные поля меняются, остальные остаются.
  async setShow(ownerId: string, id: string, raw: unknown): Promise<PublicAlbum> {
    await this.get(ownerId, id);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new BadRequestException('Поле show: допуски альбома');
    const o = raw as Record<string, unknown>;
    const col: Record<keyof AlbumShow, string> = { library: 'in_library', photos: 'in_photos', videos: 'in_videos', screenshots: 'in_screenshots' };
    const sets: string[] = [];
    const params: unknown[] = [id, ownerId];
    for (const k of SHOW_KEYS) {
      if (!(k in o)) continue;
      if (typeof o[k] !== 'boolean') throw new BadRequestException(`show.${k}: да или нет`);
      params.push(o[k]);
      sets.push(`${col[k]} = $${params.length}`);
    }
    if (sets.length === 0) throw new BadRequestException('show: укажите library, photos, videos или screenshots');
    await this.db.query(`UPDATE albums SET ${sets.join(', ')} WHERE id = $1 AND owner_id = $2`, params);
    return this.get(ownerId, id);
  }

  // Звёздочка: свой альбом в избранное или обратно.
  async setFavorite(ownerId: string, id: string, value: unknown): Promise<PublicAlbum> {
    await this.get(ownerId, id);
    if (typeof value !== 'boolean') throw new BadRequestException('Поле favorite: да или нет');
    await this.db.query('UPDATE albums SET favorite = $3 WHERE id = $1 AND owner_id = $2', [id, ownerId, value]);
    return this.get(ownerId, id);
  }

  // Добавить фото в альбом. Одно фото может лежать в нескольких альбомах; повторное добавление ничего не меняет.
  // Альбом определённого типа принимает только подходящее: не подошедшие пропускаются и считаются в rejected.
  async addFiles(ownerId: string, albumId: string, ids: string[]): Promise<{ added: number; rejected: number }> {
    const album = await this.get(ownerId, albumId);
    const total = (await this.db.query<{ n: string }>('SELECT count(*) AS n FROM files f WHERE f.owner_id = $1 AND f.trashed_at IS NULL AND f.id = ANY($2::bigint[])', [ownerId, ids])).rows[0];
    const r = await this.db.query(
      `INSERT INTO album_items (file_id, album_id)
       SELECT f.id, $2 FROM files f WHERE f.owner_id = $1 AND f.trashed_at IS NULL AND f.id = ANY($3::bigint[]) AND (${KIND_SQL[album.kind]})
       ON CONFLICT (album_id, file_id) DO NOTHING`,
      [ownerId, albumId, ids],
    );
    const fit = (await this.db.query<{ n: string }>(`SELECT count(*) AS n FROM files f WHERE f.owner_id = $1 AND f.trashed_at IS NULL AND f.id = ANY($2::bigint[]) AND (${KIND_SQL[album.kind]})`, [ownerId, ids])).rows[0];
    return { added: r.rowCount ?? 0, rejected: Number(total.n) - Number(fit.n) };
  }

  async removeFiles(ownerId: string, albumId: string, ids: string[]): Promise<number> {
    await this.get(ownerId, albumId);
    const r = await this.db.query('DELETE FROM album_items WHERE album_id = $1 AND file_id = ANY($2::bigint[])', [albumId, ids]);
    return r.rowCount ?? 0;
  }

  // Номера всех файлов альбома (без корзины): сайт по ним отмечает, что уже добавлено в «быстрый альбом».
  async fileIds(userId: string, albumId: string): Promise<string[]> {
    const { ownerId } = await this.getVisible(userId, albumId);
    const r = await this.db.query<{ id: string }>(
      `SELECT f.id FROM files f JOIN album_items ai ON ai.file_id = f.id
       WHERE ai.album_id = $1 AND f.owner_id = $2 AND f.trashed_at IS NULL`,
      [albumId, ownerId],
    );
    return r.rows.map((x) => x.id);
  }

  // Во всех ли альбомах человека лежит файл (свои альбомы; пустой список = ни в каком).
  async albumsOfFile(ownerId: string, fileId: string): Promise<{ id: string; name: string }[]> {
    if (!ID_RE.test(fileId)) throw new NotFoundException('Файл не найден');
    const own = await this.db.query('SELECT 1 FROM files WHERE id = $1 AND owner_id = $2', [fileId, ownerId]);
    if (!own.rows[0]) throw new NotFoundException('Файл не найден');
    const r = await this.db.query<{ id: string; name: string }>(
      `SELECT a.id, a.name FROM album_items ai JOIN albums a ON a.id = ai.album_id WHERE ai.file_id = $1 AND a.owner_id = $2 AND a.deleted_at IS NULL ORDER BY lower(a.name), a.id`,
      [fileId, ownerId],
    );
    return r.rows;
  }

  // Файлы альбома для архива (без корзины), старые сверху. Работает и для чужого альбома, которым поделились.
  async albumRows(userId: string, albumId: string): Promise<{ title: string; rows: FileRow[] }> {
    const { album, ownerId } = await this.getVisible(userId, albumId);
    const r = await this.db.query<FileRow>(
      `SELECT f.* FROM files f JOIN album_items ai ON ai.file_id = f.id
       WHERE ai.album_id = $1 AND f.owner_id = $2 AND f.trashed_at IS NULL ORDER BY f.taken_at, f.id`,
      [albumId, ownerId],
    );
    return { title: album.name, rows: r.rows };
  }

  // ---- Конструктор альбома: даты, источник, люди ----

  private buildQuery(o: Record<string, unknown>): { from?: string; to?: string; source: 'all' | 'photos' | 'videos' | 'screenshots' | 'albums'; albumIds: string[]; include: string[]; exclude: string[] } {
    const day = (v: unknown, what: string): string | undefined => {
      if (v === undefined || v === null || v === '') return undefined;
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new BadRequestException(`${what}: дата вида 2026-06-12`);
      return v;
    };
    const ids = (v: unknown, what: string, max: number): string[] => {
      if (v === undefined || v === null) return [];
      if (!Array.isArray(v) || v.length > max || !v.every((x) => typeof x === 'string' && ID_RE.test(x))) throw new BadRequestException(`${what}: список номеров (не больше ${max})`);
      return [...new Set(v as string[])];
    };
    const from = day(o.from, 'from'), to = day(o.to, 'to');
    if (from && to && from > to) throw new BadRequestException('Дата «с» позже даты «по»');
    const source = o.source ?? 'all';
    if (source !== 'all' && source !== 'photos' && source !== 'videos' && source !== 'screenshots' && source !== 'albums') throw new BadRequestException('source: all, photos, videos, screenshots или albums');
    const albumIds = ids(o.albumIds, 'albumIds', 100);
    if (source === 'albums' && albumIds.length === 0) throw new BadRequestException('Выберите хотя бы один альбом');
    const include = ids(o.include, 'include', 20), exclude = ids(o.exclude, 'exclude', 20);
    if (include.some((x) => exclude.includes(x))) throw new BadRequestException('Один и тот же человек не может быть и «обязательно», и «не должно быть»');
    return { from, to, source, albumIds, include, exclude };
  }

  private async buildWhere(userId: string, q: ReturnType<AlbumsService['buildQuery']>): Promise<{ where: string; params: unknown[] }> {
    const tz = process.env.DVCLOUD_TZ || 'Europe/Moscow';
    const params: unknown[] = [userId];
    const add = (v: unknown): string => { params.push(v); return `$${params.length}`; };
    let where = 'f.owner_id = $1 AND f.trashed_at IS NULL AND f.blob_id IS NOT NULL';
    if (q.from) where += ` AND (f.taken_at AT TIME ZONE ${add(tz)})::date >= ${add(q.from)}::date`;
    if (q.to) where += ` AND (f.taken_at AT TIME ZONE ${add(tz)})::date <= ${add(q.to)}::date`;
    if (q.source === 'albums') {
      where += ` AND EXISTS (SELECT 1 FROM album_items ai JOIN albums a ON a.id = ai.album_id WHERE ai.file_id = f.id AND a.owner_id = $1 AND a.deleted_at IS NULL AND ai.album_id = ANY(${add(q.albumIds)}::bigint[]))`;
    } else {
      where += ` AND (${KIND_SQL[q.source === 'all' ? 'any' : q.source]})`;
    }
    const people = [...q.include, ...q.exclude];
    if (people.length) {
      const vis = await this.db.query<{ n: string }>(
        `SELECT count(*) AS n FROM people p WHERE p.id = ANY($2::bigint[]) AND EXISTS (SELECT 1 FROM detection_people dp JOIN detections d ON d.id = dp.detection_id JOIN files vf ON vf.blob_id = d.blob_id AND vf.owner_id = $1 AND vf.trashed_at IS NULL WHERE dp.person_id = p.id)`,
        [userId, people],
      );
      if (Number(vis.rows[0].n) !== people.length) throw new NotFoundException('Такого человека нет');
    }
    const has = (p: string) => `EXISTS (SELECT 1 FROM detections d JOIN detection_people dp ON dp.detection_id = d.id WHERE d.blob_id = f.blob_id AND dp.person_id = ${add(p)})`;
    for (const p of q.include) where += ` AND ${has(p)}`;
    for (const p of q.exclude) where += ` AND NOT ${has(p)}`;
    return { where, params };
  }

  // Границы для календаря: самое раннее фото человека и сегодняшний день (по времени сервера DVCLOUD_TZ).
  async builderBounds(userId: string): Promise<{ min: string | null; max: string }> {
    const tz = process.env.DVCLOUD_TZ || 'Europe/Moscow';
    const r = await this.db.query<{ mn: string | null; mx: string }>(
      `SELECT to_char((min(f.taken_at) AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS mn, to_char((now() AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS mx FROM files f WHERE f.owner_id = $1 AND f.trashed_at IS NULL AND f.blob_id IS NOT NULL`,
      [userId, tz],
    );
    return { min: r.rows[0].mn, max: r.rows[0].mx };
  }

  async builderCount(userId: string, body: Record<string, unknown>): Promise<{ count: number }> {
    const { where, params } = await this.buildWhere(userId, this.buildQuery(body));
    return { count: Number((await this.db.query<{ n: string }>(`SELECT count(*) AS n FROM files f WHERE ${where}`, params)).rows[0].n) };
  }

  // Создать альбом (универсальный) из подходящих файлов: снимок на сегодня, новые фото сами не добавляются.
  async builderCreate(userId: string, body: Record<string, unknown>): Promise<{ album: PublicAlbum; added: number }> {
    const { where, params } = await this.buildWhere(userId, this.buildQuery(body));
    const ids = (await this.db.query<{ id: string }>(`SELECT f.id FROM files f WHERE ${where} ORDER BY f.taken_at DESC, f.id DESC LIMIT 50000`, params)).rows.map((r) => r.id);
    if (ids.length === 0) throw new BadRequestException('Под эти условия не подходит ни одного файла');
    const album = await this.create(userId, body.name, 'any');
    let added = 0;
    for (let i = 0; i < ids.length; i += 1000) added += (await this.addFiles(userId, album.id, ids.slice(i, i + 1000))).added;
    return { album: await this.get(userId, album.id), added };
  }

  // Для окна «Удалить из альбома»: сколько из этих файлов лежит ещё и в других альбомах человека и в каких.
  async inOtherAlbums(userId: string, albumId: string, ids: string[]): Promise<{ files: number; albums: { id: string; name: string }[] }> {
    await this.get(userId, albumId);
    const clean = ids.filter((x) => ID_RE.test(x));
    if (!clean.length) return { files: 0, albums: [] };
    const r = await this.db.query<{ file_id: string; id: string; name: string }>(
      `SELECT ai.file_id, a.id, a.name FROM album_items ai JOIN albums a ON a.id = ai.album_id
       WHERE ai.file_id = ANY($2::bigint[]) AND a.owner_id = $1 AND a.deleted_at IS NULL AND a.id <> $3 ORDER BY lower(a.name), a.id`,
      [userId, clean, albumId],
    );
    const albums = new Map(r.rows.map((x) => [x.id, x.name]));
    return { files: new Set(r.rows.map((x) => x.file_id)).size, albums: [...albums].slice(0, 20).map(([id, name]) => ({ id, name })) };
  }

  // «Из всех альбомов»: файлы остаются в библиотеке (корзина не затрагивается), пропадают из всех своих альбомов.
  async removeFromAllAlbums(userId: string, ids: string[]): Promise<number> {
    const clean = ids.filter((x) => ID_RE.test(x));
    if (!clean.length) return 0;
    const r = await this.db.query(
      `DELETE FROM album_items ai USING albums a, files f WHERE ai.album_id = a.id AND a.owner_id = $1 AND f.id = ai.file_id AND f.owner_id = $1 AND ai.file_id = ANY($2::bigint[])`,
      [userId, clean],
    );
    return r.rowCount ?? 0;
  }

  // ---- Предложенные альбомы (события по времени съёмки) ----

  // Свои файлы вне корзины и вне альбомов, подряд по времени. Событие: серия снимков с паузами не больше 6 часов; дни,
  // где снято не меньше 15 снимков, соседние через ночь (пауза до суток) склеиваются в поездку (до 14 дней).
  async suggestions(userId: string): Promise<AlbumSuggestion[]> {
    const MIN = Math.max(3, Number(process.env.DVCLOUD_EVENT_MIN) || 15);
    const GAP = 6 * 3600_000, NIGHT = 24 * 3600_000, MAX_SPAN = 14 * 24 * 3600_000;
    const rows = (
      await this.db.query<{ id: string; t: Date; mime: string }>(
        `SELECT f.id, f.taken_at AS t, f.mime FROM files f
         WHERE f.owner_id = $1 AND f.trashed_at IS NULL AND f.blob_id IS NOT NULL AND NOT (${hiddenFromLibrary('f', '$1')})
           AND NOT EXISTS (SELECT 1 FROM album_items ai JOIN albums a ON a.id = ai.album_id AND a.owner_id = $1 AND a.deleted_at IS NULL WHERE ai.file_id = f.id)
         ORDER BY f.taken_at, f.id`,
        [userId],
      )
    ).rows;
    type Run = { from: number; to: number; ids: string[]; mimes: string[] };
    const runs: Run[] = [];
    for (const r of rows) {
      const t = new Date(r.t).getTime();
      const last = runs[runs.length - 1];
      if (last && t - last.to <= GAP) { last.to = t; last.ids.push(r.id); last.mimes.push(r.mime); } else runs.push({ from: t, to: t, ids: [r.id], mimes: [r.mime] });
    }
    const busy = runs.filter((x) => x.ids.length >= MIN);
    const events: Run[] = [];
    for (const x of busy) {
      const last = events[events.length - 1];
      if (last && x.from - last.to <= NIGHT && x.to - last.from <= MAX_SPAN) { last.to = x.to; last.ids.push(...x.ids); last.mimes.push(...x.mimes); } else events.push({ ...x, ids: [...x.ids], mimes: [...x.mimes] });
    }
    const dismissed = (await this.db.query<{ started_at: Date }>('SELECT started_at FROM album_suggestion_dismissed WHERE user_id = $1', [userId])).rows.map((r) => new Date(r.started_at).getTime());
    const open = events.filter((e) => !dismissed.some((d) => d >= e.from - 12 * 3600_000 && d <= e.to));
    return open.reverse().slice(0, 20).map((e) => {
      const photos = e.ids.filter((_, i) => /^image\//.test(e.mimes[i]));
      const pool = photos.length ? photos : e.ids;
      return { id: String(e.from), start: new Date(e.from).toISOString(), end: new Date(e.to).toISOString(), count: e.ids.length, name: eventName(e.from, e.to), coverFileId: pool[Math.floor(pool.length / 2)], fileIds: e.ids };
    });
  }

  // Создать альбом из предложенного события (название можно поменять). Предложение пропадает, потому что файлы теперь в альбоме.
  // Файлы события для предпросмотра (номера), чтобы открыть предложение и посмотреть, что в нём.
  async suggestionFileIds(userId: string, id: unknown): Promise<string[]> {
    const s = (await this.suggestions(userId)).find((x) => x.id === id);
    if (!s) throw new NotFoundException('Такого предложения уже нет: обновите список');
    return s.fileIds;
  }

  // exclude: номера файлов, которые человек убрал из предложения при просмотре (в альбом не попадут).
  async acceptSuggestion(userId: string, id: unknown, rawName: unknown, exclude?: unknown): Promise<{ album: PublicAlbum; added: number }> {
    const s = (await this.suggestions(userId)).find((x) => x.id === id);
    if (!s) throw new NotFoundException('Такого предложения уже нет: обновите список');
    if (exclude !== undefined && exclude !== null && (!Array.isArray(exclude) || !exclude.every((x) => typeof x === 'string' && ID_RE.test(x)))) throw new BadRequestException('exclude: список номеров');
    const skip = new Set<string>((exclude as string[] | undefined) ?? []);
    s.fileIds = s.fileIds.filter((f) => !skip.has(f));
    if (s.fileIds.length === 0) throw new BadRequestException('В предложении не осталось файлов');
    const album = await this.create(userId, rawName === undefined || rawName === null || rawName === '' ? s.name : rawName, 'any');
    let added = 0;
    for (let i = 0; i < s.fileIds.length; i += 1000) added += (await this.addFiles(userId, album.id, s.fileIds.slice(i, i + 1000))).added;
    return { album: await this.get(userId, album.id), added };
  }

  // «Не нужно»: предложение больше не показывается (запоминается по началу события).
  async dismissSuggestion(userId: string, id: unknown): Promise<void> {
    if (typeof id !== 'string' || !/^\d{10,15}$/.test(id)) throw new BadRequestException('Нужен номер предложения');
    await this.db.query('INSERT INTO album_suggestion_dismissed (user_id, started_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, new Date(Number(id))]);
  }

  // ---- Общий доступ ----

  // Все остальные люди облака: с ними можно делиться (семья видит друг друга).
  async people(userId: string): Promise<PublicPerson[]> {
    const r = await this.db.query<{ login: string; display_name: string }>('SELECT login, display_name FROM users WHERE id <> $1 AND NOT disabled ORDER BY lower(display_name), login', [userId]);
    return r.rows.map((x) => ({ login: x.login, displayName: x.display_name }));
  }

  async shares(ownerId: string, albumId: string): Promise<PublicPerson[]> {
    await this.get(ownerId, albumId);
    const r = await this.db.query<{ login: string; display_name: string }>(
      'SELECT u.login, u.display_name FROM album_shares s JOIN users u ON u.id = s.user_id WHERE s.album_id = $1 ORDER BY lower(u.display_name), u.login',
      [albumId],
    );
    return r.rows.map((x) => ({ login: x.login, displayName: x.display_name }));
  }

  async share(ownerId: string, albumId: string, login: string): Promise<void> {
    await this.get(ownerId, albumId);
    const u = await this.db.query<{ id: string }>('SELECT id FROM users WHERE login = $1 AND id <> $2 AND NOT disabled', [login, ownerId]);
    if (!u.rows[0]) throw new NotFoundException('Нет такого человека');
    await this.db.query('INSERT INTO album_shares (album_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [albumId, u.rows[0].id]);
  }

  async unshare(ownerId: string, albumId: string, login: string): Promise<void> {
    await this.get(ownerId, albumId);
    await this.db.query('DELETE FROM album_shares WHERE album_id = $1 AND user_id = (SELECT id FROM users WHERE login = $2)', [albumId, login]);
  }

  // Человек убирает чужой альбом из своего списка (общий доступ закрывается только для него).
  async leave(userId: string, albumId: string): Promise<void> {
    await this.db.query('DELETE FROM album_shares WHERE album_id = $1 AND user_id = $2', [albumId, userId]);
  }

  async selectionRows(ownerId: string, ids: string[]): Promise<FileRow[]> {
    const r = await this.db.query<FileRow>(
      `SELECT f.* FROM files f WHERE f.trashed_at IS NULL AND f.id = ANY($2::bigint[]) AND (f.owner_id = $1 OR EXISTS (
         SELECT 1 FROM album_items ai JOIN album_shares s ON s.album_id = ai.album_id WHERE ai.file_id = f.id AND s.user_id = $1))
       ORDER BY f.taken_at, f.id`,
      [ownerId, ids],
    );
    return r.rows;
  }

  // Записи архива: уникальные имена, настоящие размеры с диска. Пропавшие с диска файлы в архив не попадают.
  async zipEntries(rows: FileRow[]): Promise<ZipEntry[]> {
    const used = new Set<string>();
    const out: ZipEntry[] = [];
    for (const f of rows) {
      const abs = this.storage.abs(f.path);
      let size: number;
      try {
        size = (await stat(abs)).size;
      } catch {
        continue;
      }
      const c = cleanFileName(f.original_name) ?? { stem: 'file', ext: 'bin', name: 'file.bin', mime: f.mime };
      let n = 1;
      let name = withSuffix(c, n);
      while (used.has(name.toLowerCase())) name = withSuffix(c, ++n);
      used.add(name.toLowerCase());
      out.push({ name, size, mtime: f.taken_at, open: openFile(abs) });
    }
    return out;
  }
}
