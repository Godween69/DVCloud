import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { BlobRow, FileRow, ID_RE } from './files.service';
import { StorageService } from './storage.service';

export interface AdminAlbum {
  id: string;
  name: string;
  owner: string;
  count: number;
  sharedWith: number;
}

export interface QuotaRequest {
  id: string;
  login: string;
  displayName: string;
  needBytes: number;
  note: string;
  createdAt: string;
  usedBytes: number;
  quotaBytes: number | null;
}

// Операции администратора над хранением: файлы без владельца, физическое удаление, перенос альбомов, просьбы о месте.
// Живёт во внутреннем приложении и не запускает никаких фоновых работ.
@Injectable()
export class AdminStorageService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  async stats(): Promise<{ files: number; blobs: number; orphans: number; bytes: number; extraCopies: number }> {
    const r = await this.db.query<{ files: string; blobs: string; orphans: string; bytes: string; extra: string }>(
      `SELECT (SELECT count(*) FROM files) AS files, (SELECT count(*) FROM blobs) AS blobs,
              (SELECT count(*) FROM blobs b WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.blob_id = b.id)) AS orphans,
              (SELECT COALESCE(sum(size_bytes), 0) FROM blobs) AS bytes, (SELECT count(*) FROM blob_extra_paths) AS extra`,
    );
    const x = r.rows[0];
    return { files: Number(x.files), blobs: Number(x.blobs), orphans: Number(x.orphans), bytes: Number(x.bytes), extraCopies: Number(x.extra) };
  }

  // Файлы на диске, на которые не ссылается ничей список (человек убрал у себя насовсем или удалён аккаунт).
  async orphans(limit = 200): Promise<{ id: string; name: string; size: number; createdAt: string }[]> {
    const r = await this.db.query<BlobRow>('SELECT b.* FROM blobs b WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.blob_id = b.id) ORDER BY b.id LIMIT $1', [limit]);
    return r.rows.map((b) => ({ id: b.id, name: b.path.split('/').pop() ?? b.path, size: Number(b.size_bytes), createdAt: b.created_at.toISOString() }));
  }

  private async blob(id: string): Promise<BlobRow> {
    if (!ID_RE.test(id)) throw new NotFoundException('Файл не найден');
    const b = (await this.db.query<BlobRow>('SELECT * FROM blobs WHERE id = $1', [id])).rows[0];
    if (!b) throw new NotFoundException('Файл не найден');
    return b;
  }

  // Стирает файл с диска и все записи людей о нём. Единственное место, где файлы удаляются физически.
  async purgeBlob(id: string): Promise<{ links: number; bytes: number }> {
    const b = await this.blob(id);
    const links = (await this.db.query<FileRow>('SELECT * FROM files WHERE blob_id = $1', [id])).rows;
    const extra = (await this.db.query<{ path: string }>('SELECT path FROM blob_extra_paths WHERE blob_id = $1', [id])).rows.map((x) => x.path);
    const paths = new Set<string>([b.path, ...extra, ...links.map((l) => l.path)]);
    await this.db.query('DELETE FROM files WHERE blob_id = $1', [id]);
    await this.db.query('DELETE FROM blobs WHERE id = $1', [id]);
    for (const p of paths) await this.storage.remove(p);
    for (const l of links) await this.storage.remove(`thumbs/${l.owner_id}/${l.id}.webp`);
    return { links: links.length, bytes: Number(b.size_bytes) };
  }

  // Отдать файл без владельца человеку: у него появляется запись в библиотеке.
  async adopt(id: string, login: string): Promise<FileRow> {
    const b = await this.blob(id);
    const u = (await this.db.query<{ id: string }>('SELECT id FROM users WHERE login = $1', [login])).rows[0];
    if (!u) throw new NotFoundException('Нет такого человека');
    return this.link(u.id, b, b.path.split('/').pop() ?? 'file', new Date());
  }

  private async link(userId: string, b: BlobRow, name: string, takenAt: Date): Promise<FileRow> {
    const ins = await this.db.query<FileRow>(
      `INSERT INTO files (owner_id, path, original_name, mime, size_bytes, sha256, taken_at, blob_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (owner_id, sha256) WHERE trashed_at IS NULL DO NOTHING RETURNING *`,
      [userId, b.path, name, b.mime, b.size_bytes, b.sha256, takenAt, b.id],
    );
    if (ins.rows[0]) return ins.rows[0];
    return (await this.db.query<FileRow>('SELECT * FROM files WHERE owner_id = $1 AND sha256 = $2 AND trashed_at IS NULL', [userId, b.sha256])).rows[0];
  }

  // Убирает лишние физические копии, найденные при переносе на единое хранение. Каждая сверяется по SHA-256 с основным
  // файлом, стирается только совпавшая. За вызов не больше limit копий. Без apply только проверка.
  async dedupeExtras(limit: number, apply: boolean): Promise<{ checked: number; removed: number; freedBytes: number; mismatched: string[] }> {
    const rows = (await this.db.query<{ path: string; blob_id: string }>('SELECT path, blob_id FROM blob_extra_paths ORDER BY path LIMIT $1', [limit])).rows;
    let removed = 0;
    let freed = 0;
    const mismatched: string[] = [];
    for (const x of rows) {
      const b = (await this.db.query<BlobRow>('SELECT * FROM blobs WHERE id = $1', [x.blob_id])).rows[0];
      if (!b) continue;
      const sha = await this.storage.sha256Of(x.path).catch(() => null);
      if (sha === null) {
        // Копии уже нет на диске: запись о ней лишняя.
        if (apply) {
          await this.db.query('UPDATE files SET path = $1 WHERE blob_id = $2 AND path = $3', [b.path, b.id, x.path]);
          await this.db.query('DELETE FROM blob_extra_paths WHERE path = $1', [x.path]);
        }
        continue;
      }
      if (sha !== b.sha256) {
        mismatched.push(x.path);
        continue;
      }
      if (!apply) continue;
      await this.db.query('UPDATE files SET path = $1 WHERE blob_id = $2 AND path = $3', [b.path, b.id, x.path]);
      await this.storage.remove(x.path);
      await this.db.query('DELETE FROM blob_extra_paths WHERE path = $1', [x.path]);
      removed++;
      freed += Number(b.size_bytes);
    }
    return { checked: rows.length, removed, freedBytes: freed, mismatched };
  }

  // ---- Альбомы ----

  async albums(): Promise<AdminAlbum[]> {
    const r = await this.db.query<{ id: string; name: string; owner: string; n: string; shared: string }>(
      `SELECT a.id, a.name, u.login AS owner,
         (SELECT count(*) FROM album_items ai JOIN files f ON f.id = ai.file_id WHERE ai.album_id = a.id AND f.trashed_at IS NULL) AS n,
         (SELECT count(*) FROM album_shares s WHERE s.album_id = a.id) AS shared
       FROM albums a JOIN users u ON u.id = a.owner_id ORDER BY u.login, lower(a.name)`,
    );
    return r.rows.map((x) => ({ id: x.id, name: x.name, owner: x.owner, count: Number(x.n), sharedWith: Number(x.shared) }));
  }

  // Перенос альбома другому человеку без копирования файлов: у получателя появляются свои записи на те же файлы.
  // move=false: у прежнего хозяина альбом остаётся; move=true: альбом (но не его фото) у него исчезает.
  async transferAlbum(albumId: string, toLogin: string, move: boolean): Promise<{ albumId: string; linked: number }> {
    if (!ID_RE.test(albumId)) throw new NotFoundException('Альбом не найден');
    const a = (await this.db.query<{ id: string; name: string; owner_id: string }>('SELECT id, name, owner_id FROM albums WHERE id = $1', [albumId])).rows[0];
    if (!a) throw new NotFoundException('Альбом не найден');
    const to = (await this.db.query<{ id: string }>('SELECT id FROM users WHERE login = $1', [toLogin])).rows[0];
    if (!to) throw new NotFoundException('Нет такого человека');
    if (to.id === a.owner_id) throw new BadRequestException('Альбом уже у этого человека');
    const files = (await this.db.query<FileRow>(
      `SELECT f.* FROM files f JOIN album_items ai ON ai.file_id = f.id WHERE ai.album_id = $1 AND f.trashed_at IS NULL AND f.blob_id IS NOT NULL ORDER BY f.taken_at, f.id`,
      [albumId],
    )).rows;
    let name = a.name;
    const taken = async (n: string) => (await this.db.query('SELECT 1 FROM albums WHERE owner_id = $1 AND lower(name) = lower($2)', [to.id, n])).rows.length > 0;
    for (let i = 2; await taken(name); i++) name = `${a.name} (${i})`;
    const created = (await this.db.query<{ id: string }>('INSERT INTO albums (owner_id, name) VALUES ($1, $2) RETURNING id', [to.id, name])).rows[0];
    let linked = 0;
    for (const f of files) {
      const b = (await this.db.query<BlobRow>('SELECT * FROM blobs WHERE id = $1', [f.blob_id])).rows[0];
      if (!b) continue;
      const mine = await this.link(to.id, b, f.original_name, f.taken_at);
      await this.db.query('INSERT INTO album_items (album_id, file_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [created.id, mine.id]);
      linked++;
    }
    if (move) await this.db.query('DELETE FROM albums WHERE id = $1', [albumId]);
    return { albumId: created.id, linked };
  }

  // ---- Люди ----

  // Удаление аккаунта: записи человека и его альбомы исчезают, файлы на диске остаются как «без владельца»
  // (их потом можно отдать другому или стереть). Без force аккаунт с файлами удалить нельзя.
  async deleteUser(login: string, force: boolean): Promise<{ links: number }> {
    const u = (await this.db.query<{ id: string }>('SELECT id FROM users WHERE login = $1', [login])).rows[0];
    if (!u) throw new NotFoundException('Нет такого человека');
    const n = Number((await this.db.query<{ n: string }>('SELECT count(*) AS n FROM files WHERE owner_id = $1', [u.id])).rows[0].n);
    if (n > 0 && !force) throw new ConflictException(`У человека ${n} файлов. Отдайте альбомы другим или удалите с force: файлы на диске останутся без владельца`);
    const links = (await this.db.query<FileRow>('SELECT id, owner_id FROM files WHERE owner_id = $1', [u.id])).rows;
    await this.db.query('DELETE FROM albums WHERE owner_id = $1', [u.id]);
    await this.db.query('DELETE FROM files WHERE owner_id = $1', [u.id]);
    for (const l of links) await this.storage.remove(`thumbs/${l.owner_id}/${l.id}.webp`);
    await this.db.query('DELETE FROM users WHERE id = $1', [u.id]);
    return { links: links.length };
  }

  // ---- Просьбы о месте ----

  async quotaRequests(): Promise<QuotaRequest[]> {
    const r = await this.db.query<{ id: string; login: string; display_name: string; need_bytes: string; note: string; created_at: Date; used: string; quota_bytes: string | null }>(
      `SELECT q.id, u.login, u.display_name, q.need_bytes, q.note, q.created_at, u.quota_bytes,
              (SELECT COALESCE(sum(size_bytes), 0) FROM files f WHERE f.owner_id = u.id) AS used
       FROM quota_requests q JOIN users u ON u.id = q.user_id WHERE q.resolved_at IS NULL ORDER BY q.created_at`,
    );
    return r.rows.map((x) => ({ id: x.id, login: x.login, displayName: x.display_name, needBytes: Number(x.need_bytes), note: x.note, createdAt: x.created_at.toISOString(), usedBytes: Number(x.used), quotaBytes: x.quota_bytes === null ? null : Number(x.quota_bytes) }));
  }

  async resolveQuotaRequest(id: string): Promise<void> {
    if (!ID_RE.test(id)) throw new NotFoundException('Просьба не найдена');
    const r = await this.db.query('UPDATE quota_requests SET resolved_at = now() WHERE id = $1 AND resolved_at IS NULL', [id]);
    if (!r.rowCount) throw new NotFoundException('Просьба не найдена');
  }
}
