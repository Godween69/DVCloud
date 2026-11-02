import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnsupportedMediaTypeException } from '@nestjs/common';
import { rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { Config } from '../config';
import { DbService } from '../db/db.service';
import { CONFIG } from '../tokens';
import { UserRow } from '../users/users.service';
import { cleanFileName, libraryDir, parseTakenAt, trashDir } from './names';
import { StorageService, TooLargeError } from './storage.service';

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
const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)_(\d{1,18})$/;

@Injectable()
export class FilesService {
  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    @Inject(CONFIG) private readonly cfg: Config,
  ) {}

  async usage(ownerId: string): Promise<{ usedBytes: number; count: number }> {
    const r = await this.db.query<{ used: string; n: string }>(
      'SELECT COALESCE(SUM(size_bytes), 0) AS used, COUNT(*) AS n FROM files WHERE owner_id = $1',
      [ownerId],
    );
    return { usedBytes: Number(r.rows[0].used), count: Number(r.rows[0].n) };
  }

  // Чужие и несуществующие файлы неотличимы: всегда "не найдено".
  async getOwned(ownerId: string, id: string): Promise<FileRow> {
    if (!ID_RE.test(id)) throw new NotFoundException('Файл не найден');
    const r = await this.db.query<FileRow>('SELECT * FROM files WHERE id = $1 AND owner_id = $2', [id, ownerId]);
    if (!r.rows[0]) throw new NotFoundException('Файл не найден');
    return r.rows[0];
  }

  private async findLiveBySha(ownerId: string, sha256: string): Promise<FileRow | null> {
    const r = await this.db.query<FileRow>('SELECT * FROM files WHERE owner_id = $1 AND sha256 = $2 AND trashed_at IS NULL', [ownerId, sha256]);
    return r.rows[0] ?? null;
  }

  async upload(
    user: UserRow,
    input: Readable,
    meta: { name: string; contentLength?: number; modified?: string },
  ): Promise<{ file: FileRow; duplicate: boolean }> {
    const clean = cleanFileName(meta.name);
    if (!clean) throw new UnsupportedMediaTypeException('Поддерживаются только фото и видео (jpg, png, heic, mp4, mov и подобные)');

    // Сколько ещё можно принять: меньшее из лимита одного файла и остатка квоты.
    const { usedBytes } = await this.usage(user.id);
    const quota = user.quota_bytes === null ? null : Number(user.quota_bytes);
    const room = quota === null ? this.cfg.maxUploadBytes : Math.min(this.cfg.maxUploadBytes, Math.max(0, quota - usedBytes));
    if (meta.contentLength !== undefined && meta.contentLength > room) throw new TooLargeError();

    const tmp = this.storage.newTmp();
    const { size, sha256 } = await this.storage.receive(input, tmp, room);
    try {
      if (size === 0) throw new BadRequestException('Пустой файл');
      const dup = await this.findLiveBySha(user.id, sha256);
      if (dup) return { file: dup, duplicate: true };

      const takenAt = parseTakenAt(meta.modified, Date.now());
      const rel = await this.storage.placeUnique(tmp, libraryDir(user.login, takenAt), clean);
      try {
        const r = await this.db.query<FileRow>(
          `INSERT INTO files (owner_id, path, original_name, mime, size_bytes, sha256, taken_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [user.id, rel, clean.name, clean.mime, size, sha256, takenAt],
        );
        return { file: r.rows[0], duplicate: false };
      } catch (e) {
        await this.storage.remove(rel);
        if ((e as { code?: string }).code === '23505') {
          const again = await this.findLiveBySha(user.id, sha256); // параллельная загрузка того же файла
          if (again) return { file: again, duplicate: true };
        }
        throw e;
      }
    } finally {
      await rm(tmp, { force: true });
    }
  }

  // Лента: ключ следующей страницы по (дата, id), поэтому вставки сверху её не сдвигают.
  async list(ownerId: string, opts: { trashed: boolean; limit: number; before?: string }): Promise<{ files: FileRow[]; next: string | null }> {
    const col = opts.trashed ? 'trashed_at' : 'taken_at';
    const params: unknown[] = [ownerId];
    let where = `owner_id = $1 AND trashed_at IS ${opts.trashed ? 'NOT NULL' : 'NULL'}`;
    if (opts.before !== undefined) {
      const m = CURSOR_RE.exec(opts.before);
      if (!m) throw new BadRequestException('Неверный курсор before');
      params.push(m[1], m[2]);
      where += ` AND (${col}, id) < ($2::timestamptz, $3::bigint)`;
    }
    params.push(opts.limit + 1);
    const r = await this.db.query<FileRow>(`SELECT * FROM files WHERE ${where} ORDER BY ${col} DESC, id DESC LIMIT $${params.length}`, params);
    const more = r.rows.length > opts.limit;
    const rows = more ? r.rows.slice(0, opts.limit) : r.rows;
    const last = rows[rows.length - 1];
    const next = more && last ? `${(opts.trashed ? last.trashed_at! : last.taken_at).toISOString()}_${last.id}` : null;
    return { files: rows, next };
  }

  // В корзину: файл переезжает в trash/<логин>/, из ленты пропадает, на диске остаётся.
  async trash(user: UserRow, id: string): Promise<FileRow> {
    const f = await this.getOwned(user.id, id);
    if (f.trashed_at) throw new ConflictException('Файл уже в корзине');
    const name = cleanFileName(f.original_name)!;
    const newRel = await this.storage.placeUnique(this.storage.abs(f.path), trashDir(user.login), name, `${f.id}-`);
    try {
      const r = await this.db.query<FileRow>('UPDATE files SET path = $1, trashed_at = now() WHERE id = $2 AND trashed_at IS NULL RETURNING *', [newRel, f.id]);
      if (!r.rows[0]) throw new ConflictException('Файл уже в корзине');
      return r.rows[0];
    } catch (e) {
      await this.storage.moveExact(newRel, f.path); // откат: база не обновилась, файл возвращается
      throw e;
    }
  }

  async restore(user: UserRow, id: string): Promise<FileRow> {
    const f = await this.getOwned(user.id, id);
    if (!f.trashed_at) throw new ConflictException('Файл не в корзине');
    if (await this.findLiveBySha(user.id, f.sha256)) throw new ConflictException('Такой файл уже есть в библиотеке');
    const name = cleanFileName(f.original_name)!;
    const newRel = await this.storage.placeUnique(this.storage.abs(f.path), libraryDir(user.login, f.taken_at), name);
    try {
      const r = await this.db.query<FileRow>('UPDATE files SET path = $1, trashed_at = NULL WHERE id = $2 AND trashed_at IS NOT NULL RETURNING *', [newRel, f.id]);
      if (!r.rows[0]) throw new ConflictException('Файл не в корзине');
      return r.rows[0];
    } catch (e) {
      await this.storage.moveExact(newRel, f.path);
      if ((e as { code?: string }).code === '23505') throw new ConflictException('Такой файл уже есть в библиотеке');
      throw e;
    }
  }

  // Окончательное удаление: только из корзины и только явным действием.
  async deletePermanently(user: UserRow, id: string): Promise<void> {
    const f = await this.getOwned(user.id, id);
    if (!f.trashed_at) throw new ConflictException('Сначала переложите файл в корзину');
    await this.db.query('DELETE FROM files WHERE id = $1 AND owner_id = $2 AND trashed_at IS NOT NULL', [f.id, user.id]);
    await this.storage.remove(f.path);
  }
}
