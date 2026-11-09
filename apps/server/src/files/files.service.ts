import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnsupportedMediaTypeException } from '@nestjs/common';
import { MediaSettingsService } from './media-settings';
import { detectTakenAt, validTimezone } from './taken';
import { rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { Config } from '../config';
import { DbService } from '../db/db.service';
import { CONFIG } from '../tokens';
import { UserRow } from '../users/users.service';
import { cleanFileName, libraryDir, parseTakenAt } from './names';
import { ActivityService } from './activity.service';
import { StorageService, TooLargeError } from './storage.service';
import { FingerprintService } from './fingerprint.service';
import { ThumbsService } from './thumbs.service';

// Запись файла в библиотеке человека («звено»). Сам файл на диске описывает blobs: одно содержимое хранится один раз.
export interface FileRow {
  id: string;
  owner_id: string;
  path: string;
  original_name: string;
  mime: string;
  size_bytes: string;
  sha256: string;
  taken_at: Date;
  created_at: Date;
  trashed_at: Date | null;
  blob_id: string | null;
  shot_override?: boolean | null; // ручная отметка: true скриншот, false фото, пусто решает автоматика
}

export interface BlobRow {
  id: string;
  sha256: string;
  path: string;
  mime: string;
  size_bytes: string;
  created_at: Date;
}

// Путь на диске наружу не отдаётся: клиент знает только id.
export interface PublicFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  takenAt: string;
  createdAt: string;
  trashedAt: string | null;
  // Размеры снимка в пикселях (после поворота), если они уже посчитаны; нужны «Умной плитке». У видео и новых файлов пока null.
  width: number | null;
  height: number | null;
  // Считается ли картинка скриншотом (ручная отметка или автоматика). Есть в списках ленты, в остальных ответах может отсутствовать.
  screenshot?: boolean;
}

export function toPublicFile(f: FileRow & { w?: number | null; h?: number | null; shot?: boolean | null }): PublicFile {
  return {
    id: f.id,
    name: f.original_name,
    mime: f.mime,
    size: Number(f.size_bytes),
    sha256: f.sha256,
    takenAt: f.taken_at.toISOString(),
    createdAt: f.created_at.toISOString(),
    trashedAt: f.trashed_at ? f.trashed_at.toISOString() : null,
    width: f.w ?? null,
    height: f.h ?? null,
    ...(f.shot !== undefined && f.shot !== null ? { screenshot: f.shot } : {}),
  };
}

// Условие SQL «файл спрятан из библиотеки допуском альбома» (для поиска и групп лиц). alias: имя таблицы файлов, owner: номер параметра хозяина.
export const hiddenFromLibrary = (alias: string, owner: string): string =>
  `EXISTS (SELECT 1 FROM album_items hi JOIN albums ha ON ha.id = hi.album_id WHERE hi.file_id = ${alias}.id AND ha.owner_id = ${owner} AND ha.deleted_at IS NULL AND NOT ha.in_library)`;

// Раздел ленты: library это «Библиотека» (фото и видео без скриншотов), остальные по названию. Без значения: всё подряд (для групп людей и альбомов).
export type FeedKind = 'photos' | 'videos' | 'screenshots' | 'library';

export const ID_RE = /^\d{1,18}$/;
export const SHA_RE = /^[0-9a-f]{64}$/;
const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)_(\d{1,18})$/;
export const MAX_BULK = 2000;
export const MAX_CLAIM = 200;

export type ClaimState = 'linked' | 'restored' | 'mine' | 'unknown' | 'quota' | 'bad';
export interface ClaimResult {
  sha256: string;
  state: ClaimState;
  file?: PublicFile;
}

export interface Estimate {
  usedBytes: number;
  quotaBytes: number | null;
  freeBytes: number | null; // null = без ограничения
  needBytes: number;
  fits: boolean;
}

const isUnique = (e: unknown): boolean => (e as { code?: string }).code === '23505';

@Injectable()
export class FilesService {
  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly thumbs: ThumbsService,
    private readonly fingerprints: FingerprintService,
    private readonly activity: ActivityService,
    @Inject(CONFIG) private readonly cfg: Config,
    @Inject(MediaSettingsService) private readonly settings: MediaSettingsService,
  ) {}

  async usage(ownerId: string): Promise<{ usedBytes: number; count: number }> {
    const r = await this.db.query<{ used: string; n: string }>(
      'SELECT COALESCE(SUM(size_bytes), 0) AS used, COUNT(*) AS n FROM files WHERE owner_id = $1',
      [ownerId],
    );
    return { usedBytes: Number(r.rows[0].used), count: Number(r.rows[0].n) };
  }

  // Сколько байт человек ещё может принять: меньшее из лимита одного файла и остатка квоты.
  async room(user: UserRow): Promise<number> {
    const { usedBytes } = await this.usage(user.id);
    const quota = user.quota_bytes === null ? null : Number(user.quota_bytes);
    return quota === null ? this.cfg.maxUploadBytes : Math.min(this.cfg.maxUploadBytes, Math.max(0, quota - usedBytes));
  }

  // Оценка перед загрузкой папки: влезет ли заданное число байт в остаток квоты.
  async estimate(user: UserRow, needBytes: number): Promise<Estimate> {
    const { usedBytes } = await this.usage(user.id);
    const quotaBytes = user.quota_bytes === null ? null : Number(user.quota_bytes);
    const freeBytes = quotaBytes === null ? null : Math.max(0, quotaBytes - usedBytes);
    return { usedBytes, quotaBytes, freeBytes, needBytes, fits: freeBytes === null || needBytes <= freeBytes };
  }

  // Чужие и несуществующие файлы неотличимы: всегда "не найдено".
  async getOwned(ownerId: string, id: string): Promise<FileRow> {
    if (!ID_RE.test(id)) throw new NotFoundException('Файл не найден');
    const r = await this.db.query<FileRow>('SELECT * FROM files WHERE id = $1 AND owner_id = $2', [id, ownerId]);
    if (!r.rows[0]) throw new NotFoundException('Файл не найден');
    return r.rows[0];
  }

  // Свой файл или файл из альбома, которым с человеком поделились (скрытые владельцем файлы не видны).
  async getReadable(userId: string, id: string): Promise<FileRow> {
    if (!ID_RE.test(id)) throw new NotFoundException('Файл не найден');
    const r = await this.db.query<FileRow>(
      `SELECT f.* FROM files f WHERE f.id = $1 AND (f.owner_id = $2 OR (f.trashed_at IS NULL AND EXISTS (
         SELECT 1 FROM album_items ai JOIN album_shares s ON s.album_id = ai.album_id WHERE ai.file_id = f.id AND s.user_id = $2)))`,
      [id, userId],
    );
    if (!r.rows[0]) throw new NotFoundException('Файл не найден');
    return r.rows[0];
  }

  private async findLiveBySha(ownerId: string, sha256: string): Promise<FileRow | null> {
    const r = await this.db.query<FileRow>('SELECT * FROM files WHERE owner_id = $1 AND sha256 = $2 AND trashed_at IS NULL', [ownerId, sha256]);
    return r.rows[0] ?? null;
  }

  private async findHiddenBySha(ownerId: string, sha256: string): Promise<FileRow | null> {
    const r = await this.db.query<FileRow>('SELECT * FROM files WHERE owner_id = $1 AND sha256 = $2 AND trashed_at IS NOT NULL ORDER BY id LIMIT 1', [ownerId, sha256]);
    return r.rows[0] ?? null;
  }

  private async blobBySha(sha256: string): Promise<BlobRow | null> {
    const r = await this.db.query<BlobRow>('SELECT * FROM blobs WHERE sha256 = $1', [sha256]);
    return r.rows[0] ?? null;
  }

  private async unhide(f: FileRow): Promise<FileRow> {
    const r = await this.db.query<FileRow>('UPDATE files SET trashed_at = NULL WHERE id = $1 AND trashed_at IS NOT NULL RETURNING *', [f.id]);
    return r.rows[0] ?? f;
  }

  // Новая запись человека на уже лежащий на диске файл. Гонка двух одинаковых загрузок решается уникальным индексом.
  private async linkBlob(user: UserRow, blob: BlobRow, name: string, takenAt: Date): Promise<{ file: FileRow; created: boolean }> {
    try {
      const r = await this.db.query<FileRow>(
        `INSERT INTO files (owner_id, path, original_name, mime, size_bytes, sha256, taken_at, blob_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [user.id, blob.path, name, blob.mime, blob.size_bytes, blob.sha256, takenAt, blob.id],
      );
      return { file: r.rows[0], created: true };
    } catch (e) {
      if (!isUnique(e)) throw e;
      const again = await this.findLiveBySha(user.id, blob.sha256);
      if (!again) throw e;
      return { file: again, created: false };
    }
  }

  // Дата съёмки: метаданные файла, затем имя файла, и только потом дата изменения из браузера.
  private async takenAt(abs: string, mime: string, name: string, fallback: Date): Promise<Date> {
    const tz = (await this.settings.get()).timezone;
    return (await detectTakenAt({ abs, mime, name, tz })).date ?? fallback;
  }

  private async checkRoom(user: UserRow, add: number): Promise<void> {
    if (user.quota_bytes === null) return;
    const { usedBytes } = await this.usage(user.id);
    if (usedBytes + add > Number(user.quota_bytes)) throw new TooLargeError();
  }

  // Общее окончание загрузки (обычной и по частям): файл уже лежит во временном месте, размер и SHA-256 известны.
  async finishUpload(
    user: UserRow,
    tmp: string,
    size: number,
    sha256: string,
    clean: NonNullable<ReturnType<typeof cleanFileName>>,
    modifiedAt: Date,
  ): Promise<{ file: FileRow; duplicate: boolean }> {
    const live = await this.findLiveBySha(user.id, sha256);
    if (live) return { file: live, duplicate: true };
    const hidden = await this.findHiddenBySha(user.id, sha256);
    if (hidden) return { file: await this.unhide(hidden), duplicate: false };
    await this.checkRoom(user, size);
    const takenAt = await this.takenAt(tmp, clean.mime, clean.name, modifiedAt);

    let blob = await this.blobBySha(sha256);
    let created = false;
    if (!blob) {
      const rel = await this.storage.placeUnique(tmp, libraryDir(user.login, takenAt), clean);
      const ins = await this.db.query<BlobRow>(
        'INSERT INTO blobs (sha256, path, mime, size_bytes) VALUES ($1, $2, $3, $4) ON CONFLICT (sha256) DO NOTHING RETURNING *',
        [sha256, rel, clean.mime, size],
      );
      if (ins.rows[0]) {
        blob = ins.rows[0];
        created = true;
      } else {
        await this.storage.remove(rel); // такое же содержимое успели положить параллельно: берём чужую запись
        blob = (await this.blobBySha(sha256))!;
      }
    }
    try {
      const { file, created: linked } = await this.linkBlob(user, blob, clean.name, takenAt);
      if (linked) {
        this.thumbs.warm(file); // миниатюра строится в фоне, загрузка её не ждёт
        this.fingerprints.warm(file); // отпечаток для поиска похожих тоже в фоне
      }
      return { file, duplicate: !linked };
    } catch (e) {
      if (created) {
        await this.db.query('DELETE FROM blobs WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM files WHERE blob_id = $1)', [blob.id]);
        await this.storage.remove(blob.path);
      }
      throw e;
    }
  }

  async upload(
    user: UserRow,
    input: Readable,
    meta: { name: string; contentLength?: number; modified?: string },
  ): Promise<{ file: FileRow; duplicate: boolean }> {
    const clean = cleanFileName(meta.name);
    if (!clean) throw new UnsupportedMediaTypeException('Поддерживаются только фото и видео (jpg, png, heic, mp4, mov и подобные)');
    const room = await this.room(user);
    if (meta.contentLength !== undefined && meta.contentLength > room) throw new TooLargeError();

    const end = this.activity.begin();
    const tmp = this.storage.newTmp();
    try {
      const { size, sha256 } = await this.storage.receive(input, tmp, room);
      if (size === 0) throw new BadRequestException('Пустой файл');
      return await this.finishUpload(user, tmp, size, sha256, clean, parseTakenAt(meta.modified, Date.now()));
    } finally {
      end();
      await rm(tmp, { force: true });
    }
  }

  // «Такой файл у меня уже есть?» по хешу, без передачи самого файла. Если содержимое уже лежит в облаке
  // (у этого человека скрытым или у другого), запись создаётся сразу, а загружать нечего.
  async claim(user: UserRow, items: Record<string, unknown>[]): Promise<ClaimResult[]> {
    const out: ClaimResult[] = [];
    for (const it of items) {
      const sha = typeof it.sha256 === 'string' ? it.sha256.toLowerCase() : '';
      const clean = typeof it.name === 'string' ? cleanFileName(it.name) : null;
      if (!SHA_RE.test(sha) || !clean) {
        out.push({ sha256: sha, state: 'bad' });
        continue;
      }
      const live = await this.findLiveBySha(user.id, sha);
      if (live) {
        out.push({ sha256: sha, state: 'mine', file: toPublicFile(live) });
        continue;
      }
      const hidden = await this.findHiddenBySha(user.id, sha);
      if (hidden) {
        out.push({ sha256: sha, state: 'restored', file: toPublicFile(await this.unhide(hidden)) });
        continue;
      }
      const blob = await this.blobBySha(sha);
      if (!blob) {
        out.push({ sha256: sha, state: 'unknown' });
        continue;
      }
      try {
        await this.checkRoom(user, Number(blob.size_bytes));
      } catch {
        out.push({ sha256: sha, state: 'quota' });
        continue;
      }
      const modified = parseTakenAt(typeof it.modified === 'string' || typeof it.modified === 'number' ? String(it.modified) : undefined, Date.now());
      const takenAt = await this.takenAt(this.storage.abs(blob.path), blob.mime, clean.name, modified);
      const { file, created } = await this.linkBlob(user, blob, clean.name, takenAt);
      if (created) {
        this.thumbs.warm(file);
        this.fingerprints.warm(file);
      }
      out.push({ sha256: sha, state: created ? 'linked' : 'mine', file: toPublicFile(file) });
    }
    return out;
  }

  // Лента: ключ следующей страницы по (дата, id), поэтому вставки сверху её не сдвигают.
  // ownerId здесь тот, чьи файлы показываем (для общего альбома это хозяин альбома).
  // Условия ленты, общие для списка, оглавления и проверки «есть ли новее»: владелец, корзина, альбом, человек, раздел.
  private feedFilter(ownerId: string, o: { trashed?: boolean; albumId?: string; kind?: FeedKind; person?: string }): { where: string; params: unknown[] } {
    const params: unknown[] = [ownerId];
    let where = `owner_id = $1 AND trashed_at IS ${o.trashed ? 'NOT NULL' : 'NULL'}`;
    if (o.albumId !== undefined) {
      params.push(o.albumId);
      where += ` AND id IN (SELECT file_id FROM album_items WHERE album_id = $${params.length})`;
    }
    // Файлы, на которых есть выбранный человек или питомец (группа принадлежит этому человеку).
    if (o.person !== undefined) {
      if (!ID_RE.test(o.person)) throw new BadRequestException('person: неверный номер');
      params.push(o.person);
      where += ` AND EXISTS (SELECT 1 FROM detections d JOIN detection_people dp ON dp.detection_id = d.id AND dp.owner_id = $1 JOIN people pp ON pp.id = dp.person_id AND pp.owner_id = $1 WHERE d.blob_id = files.blob_id AND dp.person_id = $${params.length})`;
    }
    // Допуски альбомов: файл не попадает в раздел, если лежит хотя бы в одном своём альбоме, у которого этот раздел выключен.
    // Внутри самого альбома и в корзине допуски не действуют; группы лиц и поиск считаются «Библиотекой».
    if (o.albumId === undefined && !o.trashed) {
      const flag = o.kind === 'photos' ? 'in_photos' : o.kind === 'videos' ? 'in_videos' : o.kind === 'screenshots' ? 'in_screenshots' : 'in_library';
      where += ` AND NOT EXISTS (SELECT 1 FROM album_items hi JOIN albums ha ON ha.id = hi.album_id WHERE hi.file_id = files.id AND ha.owner_id = $1 AND ha.deleted_at IS NULL AND NOT ha.${flag})`;
    }
    // Библиотека без скриншотов, отдельный раздел только со скриншотами (альбомы и скрытые не фильтруются).
    if (o.albumId === undefined && !o.trashed && o.kind !== undefined) {
      const shot = 'COALESCE(files.shot_override, EXISTS (SELECT 1 FROM file_fingerprints p WHERE p.file_id = files.id AND p.screenshot))'; // ручная отметка сильнее автоматики
      where += o.kind === 'videos' ? " AND mime LIKE 'video/%'" : o.kind === 'screenshots' ? ` AND ${shot}` : o.kind === 'library' ? ` AND NOT (mime LIKE 'image/%' AND ${shot})` : ` AND mime LIKE 'image/%' AND NOT ${shot}`;
    }
    return { where, params };
  }

  async list(ownerId: string, opts: { trashed: boolean; limit: number; before?: string; albumId?: string; kind?: FeedKind; at?: string; tz?: string; after?: string; person?: string }): Promise<{ files: FileRow[]; next: string | null; prev: string | null }> {
    const col = opts.trashed ? 'trashed_at' : 'taken_at';
    const filt = this.feedFilter(ownerId, opts);
    const params: unknown[] = [...filt.params];
    let where = filt.where;
    if (opts.before !== undefined) {
      const m = CURSOR_RE.exec(opts.before);
      if (!m) throw new BadRequestException('Неверный курсор before');
      params.push(m[1], m[2]);
      where += ` AND (${col}, id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`;
    }
    // Лента вверх от курсора: файлы новее ключа after (для прокрутки к новым после перехода к месяцу).
    if (opts.after !== undefined) {
      const m = CURSOR_RE.exec(opts.after);
      if (!m || opts.trashed || opts.before !== undefined) throw new BadRequestException('Неверный курсор after');
      params.push(m[1], m[2]);
      where += ` AND (taken_at, id) > ($${params.length - 1}::timestamptz, $${params.length}::bigint)`;
    }
    // Лента с выбранного месяца: берём всё, что старше начала следующего месяца (по часовому поясу человека).
    if (opts.at !== undefined && !opts.trashed && opts.after === undefined) {
      const m = /^(\d{4})-(\d{2})$/.exec(opts.at);
      if (!m || Number(m[2]) < 1 || Number(m[2]) > 12 || Number(m[1]) < 1971) throw new BadRequestException('at: месяц вида 2015-03');
      const tz = opts.tz ?? 'UTC';
      if (!validTimezone(tz)) throw new BadRequestException('tz: неизвестный часовой пояс');
      params.push(`${m[1]}-${m[2]}-01`, tz);
      where += ` AND taken_at < ((($${params.length - 1}::date + interval '1 month')::timestamp) AT TIME ZONE $${params.length})`;
    }
    params.push(opts.limit + 1);
    const up = opts.after !== undefined; // идём вверх: берём ближайшие к ключу, потом разворачиваем в обычный порядок
    const dir = up ? 'ASC' : 'DESC';
    const r = await this.db.query<FileRow & { w: number | null; h: number | null; shot: boolean }>(`SELECT files.*, p.width AS w, p.height AS h, COALESCE(files.shot_override, p.screenshot, false) AS shot FROM files LEFT JOIN file_fingerprints p ON p.file_id = files.id WHERE ${where} ORDER BY ${col} ${dir}, id ${dir} LIMIT $${params.length}`, params);
    const more = r.rows.length > opts.limit;
    let rows = more ? r.rows.slice(0, opts.limit) : r.rows;
    if (up) rows = rows.reverse();
    const cur = (f: FileRow): string => `${(opts.trashed ? f.trashed_at! : f.taken_at).toISOString()}_${f.id}`;
    const last = rows[rows.length - 1];
    const first = rows[0];
    const next = !up && more && last ? cur(last) : null;
    // prev: есть ли файлы новее верхнего в ответе (нужен для ленты, начатой с месяца, и для самой прокрутки вверх)
    let prev: string | null = null;
    if (up) prev = more && first ? cur(first) : null;
    else if (opts.at !== undefined && opts.before === undefined && first) {
      // «Есть ли новее» считается в той же ленте: в альбоме, у человека и в разделе только среди их файлов
      const nw = await this.db.query(`SELECT 1 FROM files WHERE ${filt.where} AND (taken_at, id) > ($${filt.params.length + 1}::timestamptz, $${filt.params.length + 2}::bigint) LIMIT 1`, [...filt.params, first.taken_at.toISOString(), first.id]);
      prev = nw.rowCount ? cur(first) : null;
    }
    return { files: rows, next, prev };
  }

  // Оглавление ленты для полосы времени: сколько файлов в каждом месяце (по часовому поясу человека), новые сверху.
  async timeline(ownerId: string, kind: FeedKind | undefined, tz: string, opts: { albumId?: string; person?: string } = {}): Promise<{ y: number; m: number; n: number }[]> {
    if (!validTimezone(tz)) throw new BadRequestException('tz: неизвестный часовой пояс');
    const f = this.feedFilter(ownerId, { kind, albumId: opts.albumId, person: opts.person });
    const r = await this.db.query<{ y: number; m: number; n: string }>(
      `SELECT EXTRACT(YEAR FROM taken_at AT TIME ZONE $${f.params.length + 1})::int AS y, EXTRACT(MONTH FROM taken_at AT TIME ZONE $${f.params.length + 1})::int AS m, count(*) AS n
       FROM files WHERE ${f.where} GROUP BY 1, 2 ORDER BY 1 DESC, 2 DESC`, [...f.params, tz]);
    return r.rows.map((x) => ({ y: x.y, m: x.m, n: Number(x.n) }));
  }

  // Скрыть: файл пропадает из ленты человека, на диске ничего не двигается и не удаляется.
  async trash(user: UserRow, id: string): Promise<FileRow> {
    const f = await this.getOwned(user.id, id);
    if (f.trashed_at) throw new ConflictException('Файл уже в корзине');
    const r = await this.db.query<FileRow>('UPDATE files SET trashed_at = now() WHERE id = $1 AND trashed_at IS NULL RETURNING *', [f.id]);
    if (!r.rows[0]) throw new ConflictException('Файл уже в корзине');
    return r.rows[0];
  }

  async restore(user: UserRow, id: string): Promise<FileRow> {
    const f = await this.getOwned(user.id, id);
    if (!f.trashed_at) throw new ConflictException('Файл не в корзине');
    if (await this.findLiveBySha(user.id, f.sha256)) throw new ConflictException('Такой файл уже есть в библиотеке');
    try {
      const r = await this.db.query<FileRow>('UPDATE files SET trashed_at = NULL WHERE id = $1 AND trashed_at IS NOT NULL RETURNING *', [f.id]);
      if (!r.rows[0]) throw new ConflictException('Файл не в корзине');
      return r.rows[0];
    } catch (e) {
      if (isUnique(e)) throw new ConflictException('Такой файл уже есть в библиотеке');
      throw e;
    }
  }

  // «Убрать у себя насовсем»: только из корзины. Пропадает запись человека (и её место в квоте), а сам файл
  // на диске остаётся: физически стирает только администратор.
  async deletePermanently(user: UserRow, id: string): Promise<void> {
    const f = await this.getOwned(user.id, id);
    if (!f.trashed_at) throw new ConflictException('Сначала переложите файл в корзину');
    await this.dropLinks([f], 'Убрал насовсем из корзины');
  }

  async emptyTrash(user: UserRow): Promise<number> {
    const r = await this.db.query<FileRow>('SELECT * FROM files WHERE owner_id = $1 AND trashed_at IS NOT NULL', [user.id]);
    await this.dropLinks(r.rows, 'Очистил корзину');
    return r.rows.length;
  }

  // Массовые действия над своими файлами. Возвращает, сколько записей изменилось.
  async bulk(user: UserRow, action: 'hide' | 'restore' | 'remove', ids: string[]): Promise<number> {
    if (action === 'hide') {
      const r = await this.db.query('UPDATE files SET trashed_at = now() WHERE owner_id = $1 AND trashed_at IS NULL AND id = ANY($2::bigint[])', [user.id, ids]);
      return r.rowCount ?? 0;
    }
    if (action === 'restore') {
      // Возвращаются только те, у кого нет такой же живой записи (иначе упёрлись бы в уникальный индекс).
      const r = await this.db.query(
        `UPDATE files f SET trashed_at = NULL WHERE f.owner_id = $1 AND f.trashed_at IS NOT NULL AND f.id = ANY($2::bigint[])
           AND NOT EXISTS (SELECT 1 FROM files g WHERE g.owner_id = f.owner_id AND g.sha256 = f.sha256 AND g.trashed_at IS NULL)`,
        [user.id, ids],
      );
      return r.rowCount ?? 0;
    }
    const r = await this.db.query<FileRow>('SELECT * FROM files WHERE owner_id = $1 AND trashed_at IS NOT NULL AND id = ANY($2::bigint[])', [user.id, ids]);
    await this.dropLinks(r.rows, 'Убрал насовсем из корзины');
    return r.rows.length;
  }

  // Ручная отметка «скриншот» или «фото» у картинок (видео не затрагиваются). 'auto' снимает ручную отметку, снова решает автоматика.
  async setKind(user: UserRow, kind: 'screenshot' | 'photo' | 'auto', ids: string[]): Promise<number> {
    const v = kind === 'auto' ? null : kind === 'screenshot';
    const r = await this.db.query(
      "UPDATE files SET shot_override = $3 WHERE owner_id = $1 AND trashed_at IS NULL AND mime LIKE 'image/%' AND id = ANY($2::bigint[]) AND shot_override IS DISTINCT FROM $3",
      [user.id, ids, v],
    );
    return r.rowCount ?? 0;
  }

  // why: как это произошло, попадёт в пометку «откуда» у файла без владельца (её видит админ).
  private async dropLinks(rows: FileRow[], why: string): Promise<void> {
    if (rows.length === 0) return;
    const ids = rows.map((f) => f.id);
    // Пока записи живы, запоминаем, чьи они были и в каких альбомах лежали: потом это уже не узнать.
    const info = await this.db.query<{ blob_id: string; login: string; albums: string }>(
      `SELECT f.blob_id, u.login,
              COALESCE(string_agg(DISTINCT a.name || CASE WHEN a.deleted_at IS NOT NULL THEN ' (альбом удалён)' ELSE '' END, ', '), '') AS albums
       FROM files f JOIN users u ON u.id = f.owner_id
       LEFT JOIN album_items ai ON ai.file_id = f.id LEFT JOIN albums a ON a.id = ai.album_id
       WHERE f.id = ANY($1::bigint[]) AND f.blob_id IS NOT NULL GROUP BY f.blob_id, u.login`,
      [ids],
    );
    await this.db.query('DELETE FROM files WHERE id = ANY($1::bigint[])', [ids]);
    for (const i of info.rows) await this.noteOrphan(i.blob_id, `${why}: ${i.login}${i.albums ? `. Был в альбомах: ${i.albums}` : '. В альбомах не лежал'}`);
    for (const f of rows) await this.thumbs.remove(f);
  }

  // Если у содержимого не осталось владельцев, записать, откуда оно такое. Если владельцы ещё есть, ничего не делает.
  async noteOrphan(blobId: string, note: string): Promise<void> {
    await this.db.query(
      'UPDATE blobs SET orphaned_at = now(), orphan_note = $2 WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM files f WHERE f.blob_id = $1)',
      [blobId, note.slice(0, 500)],
    );
  }

  // Сохранить себе файлы чужого альбома, которым поделились: в облаке они не копируются, у человека появляются свои записи.
  async saveShared(user: UserRow, ids: string[]): Promise<{ added: number; skipped: number; quota: boolean }> {
    const r = await this.db.query<FileRow>(
      `SELECT f.* FROM files f WHERE f.id = ANY($2::bigint[]) AND f.owner_id <> $1 AND f.trashed_at IS NULL AND f.blob_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM album_items ai JOIN album_shares s ON s.album_id = ai.album_id WHERE ai.file_id = f.id AND s.user_id = $1)
       ORDER BY f.taken_at, f.id`,
      [user.id, ids],
    );
    let added = 0;
    let skipped = 0;
    for (const f of r.rows) {
      if (await this.findLiveBySha(user.id, f.sha256)) {
        skipped++;
        continue;
      }
      const blob = (await this.db.query<BlobRow>('SELECT * FROM blobs WHERE id = $1', [f.blob_id])).rows[0];
      if (!blob) continue;
      try {
        await this.checkRoom(user, Number(blob.size_bytes));
      } catch {
        return { added, skipped, quota: true };
      }
      const { file, created } = await this.linkBlob(user, blob, f.original_name, f.taken_at);
      if (created) {
        added++;
        this.thumbs.warm(file);
        this.fingerprints.warm(file);
      } else skipped++;
    }
    return { added, skipped, quota: false };
  }

  // Просьба добавить место: администратор увидит её в админке.
  async requestQuota(user: UserRow, needBytes: number, note: string): Promise<void> {
    await this.db.query('INSERT INTO quota_requests (user_id, need_bytes, note) VALUES ($1, $2, $3)', [user.id, needBytes, note.slice(0, 300)]);
  }
}
