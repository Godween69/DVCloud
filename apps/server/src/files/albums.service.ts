import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { stat } from 'node:fs/promises';
import { DbService } from '../db/db.service';
import { FileRow, ID_RE } from './files.service';
import { cleanFileName, withSuffix } from './names';
import { StorageService } from './storage.service';
import { openFile, ZipEntry } from './zip';

export interface PublicAlbum {
  id: string;
  name: string;
  count: number;
  coverFileId: string | null;
  createdAt: string;
}

interface AlbumRow {
  id: string;
  name: string;
  created_at: Date;
  n: string;
  cover: string | null;
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

const toPublic = (r: AlbumRow): PublicAlbum => ({ id: r.id, name: r.name, count: Number(r.n), coverFileId: r.cover, createdAt: r.created_at.toISOString() });

const ALBUM_SELECT = `SELECT a.id, a.name, a.created_at,
  (SELECT count(*) FROM album_files af JOIN files f ON f.id = af.file_id WHERE af.album_id = a.id AND f.trashed_at IS NULL) AS n,
  (SELECT f.id FROM album_files af JOIN files f ON f.id = af.file_id WHERE af.album_id = a.id AND f.trashed_at IS NULL ORDER BY f.taken_at DESC, f.id DESC LIMIT 1) AS cover
  FROM albums a`;

@Injectable()
export class AlbumsService {
  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
  ) {}

  async list(ownerId: string): Promise<PublicAlbum[]> {
    const r = await this.db.query<AlbumRow>(`${ALBUM_SELECT} WHERE a.owner_id = $1 ORDER BY lower(a.name), a.id`, [ownerId]);
    return r.rows.map(toPublic);
  }

  // Чужой и несуществующий альбом неотличимы.
  async get(ownerId: string, id: string): Promise<PublicAlbum> {
    if (!ID_RE.test(id)) throw new NotFoundException('Альбом не найден');
    const r = await this.db.query<AlbumRow>(`${ALBUM_SELECT} WHERE a.id = $1 AND a.owner_id = $2`, [id, ownerId]);
    if (!r.rows[0]) throw new NotFoundException('Альбом не найден');
    return toPublic(r.rows[0]);
  }

  async create(ownerId: string, rawName: unknown): Promise<PublicAlbum> {
    const name = cleanAlbumName(rawName);
    try {
      const r = await this.db.query<{ id: string }>('INSERT INTO albums (owner_id, name) VALUES ($1, $2) RETURNING id', [ownerId, name]);
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

  // Удаляется только сам альбом: фото остаются в библиотеке.
  async remove(ownerId: string, id: string): Promise<void> {
    await this.get(ownerId, id);
    await this.db.query('DELETE FROM albums WHERE id = $1 AND owner_id = $2', [id, ownerId]);
  }

  // Добавить фото в альбом. Если фото уже лежало в другом альбоме, оно переезжает (это и есть «Сменить альбом»).
  async addFiles(ownerId: string, albumId: string, ids: string[]): Promise<number> {
    await this.get(ownerId, albumId);
    const r = await this.db.query(
      `INSERT INTO album_files (file_id, album_id)
       SELECT f.id, $2 FROM files f WHERE f.owner_id = $1 AND f.trashed_at IS NULL AND f.id = ANY($3::bigint[])
       ON CONFLICT (file_id) DO UPDATE SET album_id = EXCLUDED.album_id, added_at = now()`,
      [ownerId, albumId, ids],
    );
    return r.rowCount ?? 0;
  }

  async removeFiles(ownerId: string, albumId: string, ids: string[]): Promise<number> {
    await this.get(ownerId, albumId);
    const r = await this.db.query('DELETE FROM album_files WHERE album_id = $1 AND file_id = ANY($2::bigint[])', [albumId, ids]);
    return r.rowCount ?? 0;
  }

  // Номера всех файлов альбома (без корзины): сайт по ним отмечает, что уже добавлено в «быстрый альбом».
  async fileIds(ownerId: string, albumId: string): Promise<string[]> {
    await this.get(ownerId, albumId);
    const r = await this.db.query<{ id: string }>(
      `SELECT f.id FROM files f JOIN album_files af ON af.file_id = f.id
       WHERE af.album_id = $1 AND f.owner_id = $2 AND f.trashed_at IS NULL`,
      [albumId, ownerId],
    );
    return r.rows.map((x) => x.id);
  }

  async albumOfFile(ownerId: string, fileId: string): Promise<{ id: string; name: string } | null> {
    if (!ID_RE.test(fileId)) throw new NotFoundException('Файл не найден');
    const r = await this.db.query<{ id: string; name: string }>(
      `SELECT a.id, a.name FROM files f LEFT JOIN album_files af ON af.file_id = f.id LEFT JOIN albums a ON a.id = af.album_id
       WHERE f.id = $1 AND f.owner_id = $2`,
      [fileId, ownerId],
    );
    if (!r.rows[0]) throw new NotFoundException('Файл не найден');
    return r.rows[0].id ? { id: r.rows[0].id, name: r.rows[0].name } : null;
  }

  // Файлы альбома для архива (без корзины), старые сверху.
  async albumRows(ownerId: string, albumId: string): Promise<{ title: string; rows: FileRow[] }> {
    const a = await this.get(ownerId, albumId);
    const r = await this.db.query<FileRow>(
      `SELECT f.* FROM files f JOIN album_files af ON af.file_id = f.id
       WHERE af.album_id = $1 AND f.owner_id = $2 AND f.trashed_at IS NULL ORDER BY f.taken_at, f.id`,
      [albumId, ownerId],
    );
    return { title: a.name, rows: r.rows };
  }

  async selectionRows(ownerId: string, ids: string[]): Promise<FileRow[]> {
    const r = await this.db.query<FileRow>(
      'SELECT * FROM files WHERE owner_id = $1 AND trashed_at IS NULL AND id = ANY($2::bigint[]) ORDER BY taken_at, id',
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
