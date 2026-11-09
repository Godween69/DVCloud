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
  mine: boolean; // false: альбом чужой, им поделились
  ownerName: string | null; // у чужого альбома: кто поделился
  sharedWith: number; // у своего альбома: со сколькими людьми он общий
  // Где файлы альбома видны в ленте (внутри самого альбома они видны всегда). Относится к своим альбомам.
  show: AlbumShow;
}

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
  };
};

const ALBUM_SELECT = `SELECT a.id, a.owner_id, a.name, a.created_at, u.display_name AS owner_name, a.in_library, a.in_photos, a.in_videos, a.in_screenshots,
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

  // Свои альбомы и те, которыми поделились. Свои сначала.
  async list(userId: string): Promise<PublicAlbum[]> {
    const r = await this.db.query<AlbumRow>(`${ALBUM_SELECT} WHERE ${VISIBLE} ORDER BY (a.owner_id = $1) DESC, lower(a.name), a.id`, [userId]);
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

  // Добавить фото в альбом. Одно фото может лежать в нескольких альбомах; повторное добавление ничего не меняет.
  async addFiles(ownerId: string, albumId: string, ids: string[]): Promise<number> {
    await this.get(ownerId, albumId);
    const r = await this.db.query(
      `INSERT INTO album_items (file_id, album_id)
       SELECT f.id, $2 FROM files f WHERE f.owner_id = $1 AND f.trashed_at IS NULL AND f.id = ANY($3::bigint[])
       ON CONFLICT (album_id, file_id) DO NOTHING`,
      [ownerId, albumId, ids],
    );
    return r.rowCount ?? 0;
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
