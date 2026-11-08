import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnsupportedMediaTypeException } from '@nestjs/common';
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
}

export function toPublicFile(f: FileRow): PublicFile {
  return {
    id: f.id,
    name: f.original_name,
    mime: f.mime,
    size: Number(f.size_bytes),
    sha256: f.sha256,
    takenAt: f.taken_at.toISOString(),
    createdAt: f.created_at.toISOString(),
    trashedAt: f.trashed_at ? f.trashed_at.toISOString() : null,
  };
}

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
    takenAt: Date,
  ): Promise<{ file: FileRow; duplicate: boolean }> {
    const live = await this.findLiveBySha(user.id, sha256);
    if (live) return { file: live, duplicate: true };
    const hidden = await this.findHiddenBySha(user.id, sha256);
    if (hidden) return { file: await this.unhide(hidden), duplicate: false };
    await this.checkRoom(user, size);

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
      const takenAt = parseTakenAt(typeof it.modified === 'string' || typeof it.modified === 'number' ? String(it.modified) : undefined, Date.now());
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
  async list(ownerId: string, opts: { trashed: boolean; limit: number; before?: string; albumId?: string }): Promise<{ files: FileRow[]; next: string | null }> {
    const col = opts.trashed ? 'trashed_at' : 'taken_at';
    const params: unknown[] = [ownerId];
    let where = `owner_id = $1 AND trashed_at IS ${opts.trashed ? 'NOT NULL' : 'NULL'}`;
    if (opts.before !== undefined) {
      const m = CURSOR_RE.exec(opts.before);
      if (!m) throw new BadRequestException('Неверный курсор before');
      params.push(m[1], m[2]);
      where += ` AND (${col}, id) < ($2::timestamptz, $3::bigint)`;
    }
    if (opts.albumId !== undefined) {
      params.push(opts.albumId);
      where += ` AND id IN (SELECT file_id FROM album_items WHERE album_id = $${params.length})`;
    }
    params.push(opts.limit + 1);
    const r = await this.db.query<FileRow>(`SELECT * FROM files WHERE ${where} ORDER BY ${col} DESC, id DESC LIMIT $${params.length}`, params);
    const more = r.rows.length > opts.limit;
    const rows = more ? r.rows.slice(0, opts.limit) : r.rows;
    const last = rows[rows.length - 1];
    const next = more && last ? `${(opts.trashed ? last.trashed_at! : last.taken_at).toISOString()}_${last.id}` : null;
    return { files: rows, next };
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
    await this.dropLinks([f]);
  }

  async emptyTrash(user: UserRow): Promise<number> {
    const r = await this.db.query<FileRow>('SELECT * FROM files WHERE owner_id = $1 AND trashed_at IS NOT NULL', [user.id]);
    await this.dropLinks(r.rows);
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
    await this.dropLinks(r.rows);
    return r.rows.length;
  }

  private async dropLinks(rows: FileRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.query('DELETE FROM files WHERE id = ANY($1::bigint[])', [rows.map((f) => f.id)]);
    for (const f of rows) await this.thumbs.remove(f);
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
