import { rm } from 'node:fs/promises';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { BlobRow, FileRow, ID_RE } from './files.service';
import { MediaSettingsService } from './media-settings';
import { StorageService } from './storage.service';
import { dateEvidence, DateEvidence } from './taken';

export interface AdminAlbum {
  id: string;
  name: string;
  owner: string;
  count: number;
  sharedWith: number;
  deletedAt?: string; // у удалённого человеком альбома: когда он его удалил
  show?: { library: boolean; photos: boolean; videos: boolean; screenshots: boolean };
  kind?: 'any' | 'photos' | 'videos' | 'screenshots';
}

export interface AdminFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  owner: string;
  takenAt: string;
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
    @Inject(MediaSettingsService) private readonly settings: MediaSettingsService,
  ) {}

  async stats(): Promise<{ files: number; blobs: number; orphans: number; orphanBytes: number; bytes: number; extraCopies: number; yandex: { accounts: number; expired: number; items: number; done: number } }> {
    const r = await this.db.query<{ files: string; blobs: string; orphans: string; orphan_bytes: string; bytes: string; extra: string }>(
      `SELECT (SELECT count(*) FROM files) AS files, (SELECT count(*) FROM blobs) AS blobs,
              (SELECT count(*) FROM blobs b WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.blob_id = b.id) AND NOT EXISTS (SELECT 1 FROM vault_items v WHERE v.blob_id = b.id)) AS orphans,
              (SELECT COALESCE(sum(size_bytes), 0) FROM blobs b WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.blob_id = b.id) AND NOT EXISTS (SELECT 1 FROM vault_items v WHERE v.blob_id = b.id)) AS orphan_bytes,
              (SELECT COALESCE(sum(size_bytes), 0) FROM blobs) AS bytes, (SELECT count(*) FROM blob_extra_paths) AS extra`,
    );
    const x = r.rows[0];
    // Яндекс Диск: только числа, без имён и без сессий.
    const y = (await this.db.query<{ accounts: string; expired: string; items: string; done: string }>(
      `SELECT (SELECT count(*) FROM yandex_accounts) AS accounts, (SELECT count(*) FROM yandex_accounts WHERE state = 'expired') AS expired,
              (SELECT count(*) FROM yandex_items) AS items, (SELECT count(*) FROM yandex_items WHERE state = 'done') AS done`,
    )).rows[0];
    return {
      files: Number(x.files), blobs: Number(x.blobs), orphans: Number(x.orphans), orphanBytes: Number(x.orphan_bytes), bytes: Number(x.bytes), extraCopies: Number(x.extra),
      yandex: { accounts: Number(y.accounts), expired: Number(y.expired), items: Number(y.items), done: Number(y.done) },
    };
  }

  // Файлы на диске, на которые не ссылается ничей список (человек убрал у себя насовсем или удалён аккаунт).
  async orphans(limit = 200): Promise<{ id: string; name: string; size: number; createdAt: string; note: string | null; orphanedAt: string | null }[]> {
    const r = await this.db.query<BlobRow & { orphaned_at: Date | null; orphan_note: string | null }>('SELECT b.* FROM blobs b WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.blob_id = b.id) AND NOT EXISTS (SELECT 1 FROM vault_items v WHERE v.blob_id = b.id) ORDER BY b.id LIMIT $1', [limit]);
    return r.rows.map((b) => ({
      id: b.id, name: b.orphan_name ?? b.path.split('/').pop() ?? b.path, size: Number(b.size_bytes), createdAt: b.created_at.toISOString(),
      note: b.orphan_note, orphanedAt: b.orphaned_at ? b.orphaned_at.toISOString() : null,
    }));
  }

  // Стирает с диска сразу все файлы без владельца. confirm = число, которое человек видел на экране: если файлов стало
  // другое число (кто-то загрузил или отдал файл), ничего не стирается. Файл, у которого за это время появился владелец, пропускается.
  async purgeOrphans(confirm: number): Promise<{ count: number; bytes: number; skipped: number }> {
    const now = (await this.stats()).orphans;
    if (now !== confirm) throw new ConflictException(`Файлов без владельца сейчас ${now}, а подтверждено ${confirm}. Обновите страницу и проверьте число.`);
    let count = 0, bytes = 0, skipped = 0, last = '0';
    for (;;) {
      const batch = (await this.db.query<BlobRow>('SELECT b.* FROM blobs b WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.blob_id = b.id) AND NOT EXISTS (SELECT 1 FROM vault_items v WHERE v.blob_id = b.id) AND b.id > $1 ORDER BY b.id LIMIT 100', [last])).rows;
      if (batch.length === 0) break;
      for (const b of batch) {
        last = b.id;
        const extra = (await this.db.query<{ path: string }>('SELECT path FROM blob_extra_paths WHERE blob_id = $1', [b.id])).rows.map((x) => x.path);
        const del = await this.db.query('DELETE FROM blobs b WHERE b.id = $1 AND NOT EXISTS (SELECT 1 FROM files f WHERE f.blob_id = b.id) AND NOT EXISTS (SELECT 1 FROM vault_items v WHERE v.blob_id = b.id)', [b.id]); // в сейфе не стирается
        if (!del.rowCount) { skipped++; continue; }
        for (const p of new Set<string>([b.path, ...extra])) await this.storage.remove(p);
        await this.storage.remove(`videos/${b.id}.mp4`);
        await this.removeDerived(b.id, []);
        count++;
        bytes += Number(b.size_bytes);
      }
    }
    return { count, bytes, skipped };
  }

  private async blob(id: string): Promise<BlobRow> {
    if (!ID_RE.test(id)) throw new NotFoundException('Файл не найден');
    const b = (await this.db.query<BlobRow>('SELECT * FROM blobs WHERE id = $1', [id])).rows[0];
    if (!b) throw new NotFoundException('Файл не найден');
    return b;
  }

  // Миниатюра и превью файла-оригинала (общие) уходят вместе с ним; прежние по записям, если ещё не перенесены, тоже.
  private async removeDerived(blobId: string, links: Pick<FileRow, 'owner_id' | 'id'>[]): Promise<void> {
    await this.storage.remove(`thumbs/${blobId}.webp`);
    await this.storage.remove(`thumbs-fit/${blobId}.webp`);
    await this.storage.remove(`previews/${blobId}.webp`);
    await rm(this.storage.abs(`faces/${blobId}`), { recursive: true, force: true }); // вырезки лиц
    for (const l of links) await this.removeLegacyDerived(l);
  }

  private async removeLegacyDerived(l: Pick<FileRow, 'owner_id' | 'id'>): Promise<void> {
    await this.storage.remove(`thumbs/${l.owner_id}/${l.id}.webp`);
    await this.storage.remove(`previews/${l.owner_id}/${l.id}.webp`);
  }

  // Стирает файл с диска и все записи людей о нём. Единственное место, где файлы удаляются физически.
  async purgeBlob(id: string): Promise<{ links: number; bytes: number }> {
    const b = await this.blob(id);
    await this.refuseIfVault(id);
    const links = (await this.db.query<FileRow>('SELECT * FROM files WHERE blob_id = $1', [id])).rows;
    const extra = (await this.db.query<{ path: string }>('SELECT path FROM blob_extra_paths WHERE blob_id = $1', [id])).rows.map((x) => x.path);
    const paths = new Set<string>([b.path, ...extra, ...links.map((l) => l.path)]);
    await this.db.query('DELETE FROM files WHERE blob_id = $1', [id]);
    await this.db.query('DELETE FROM blobs WHERE id = $1', [id]);
    for (const p of paths) await this.storage.remove(p);
    await this.storage.remove(`videos/${id}.mp4`); // копия для просмотра (строка video_copies ушла вместе с blobs)
    await this.removeDerived(id, links);
    return { links: links.length, bytes: Number(b.size_bytes) };
  }

  // Отдать файл без владельца человеку: у него появляется запись в библиотеке.
  async adopt(id: string, login: string): Promise<FileRow> {
    const b = await this.blob(id);
    const u = (await this.db.query<{ id: string }>('SELECT id FROM users WHERE login = $1', [login])).rows[0];
    if (!u) throw new NotFoundException('Нет такого человека');
    return this.link(u.id, b, b.orphan_name ?? b.path.split('/').pop() ?? 'file', b.orphan_taken_at ?? new Date());
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

  // ---- Просмотр всех файлов ----

  // Файлы всех людей (кроме корзины): фильтр по человеку, по датам съёмки (по часовому поясу из настроек) и по части имени.
  // Постранично по курсору «время_номер», как лента людей. total: сколько всего под фильтр.
  private async browseWhere(o: { login?: string; from?: string; to?: string; q?: string; albumId?: string }, params: unknown[]): Promise<string> {
    const tz = (await this.settings.get()).timezone;
    const day = /^\d{4}-\d{2}-\d{2}$/;
    if ((o.from !== undefined && !day.test(o.from)) || (o.to !== undefined && !day.test(o.to))) throw new BadRequestException('Дата вида 2026-11-09');
    if (o.albumId !== undefined && !ID_RE.test(o.albumId)) throw new NotFoundException('Альбом не найден');
    const add = (v: unknown): string => { params.push(v); return `$${params.length}`; };
    let where = 'f.trashed_at IS NULL AND f.blob_id IS NOT NULL';
    if (o.login) where += ` AND u.login = ${add(o.login)}`;
    if (o.from) where += ` AND f.taken_at >= (${add(o.from)}::date)::timestamp AT TIME ZONE ${add(tz)}`;
    if (o.to) where += ` AND f.taken_at < ((${add(o.to)}::date + 1)::timestamp AT TIME ZONE ${add(tz)})`;
    if (o.q) where += ` AND f.original_name ILIKE ${add('%' + o.q.replace(/[\\%_]/g, (c) => '\\' + c) + '%')}`;
    if (o.albumId) where += ` AND f.id IN (SELECT file_id FROM album_items WHERE album_id = ${add(o.albumId)})`;
    return where;
  }

  async browse(o: { login?: string; from?: string; to?: string; q?: string; albumId?: string; limit: number; before?: string }): Promise<{ files: AdminFile[]; next: string | null; total: number }> {
    const params: unknown[] = [];
    const add = (v: unknown): string => { params.push(v); return `$${params.length}`; };
    const where = await this.browseWhere(o, params);
    const total = Number((await this.db.query<{ n: string }>(`SELECT count(*) AS n FROM files f JOIN users u ON u.id = f.owner_id WHERE ${where}`, params)).rows[0].n);
    let page = where;
    if (o.before !== undefined) {
      const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)_(\d{1,18})$/.exec(o.before);
      if (!m) throw new BadRequestException('Неверный курсор before');
      page += ` AND (f.taken_at, f.id) < (${add(m[1])}::timestamptz, ${add(m[2])}::bigint)`;
    }
    const r = await this.db.query<{ id: string; name: string; mime: string; size_bytes: string; owner: string; taken_at: Date }>(
      `SELECT f.id, f.original_name AS name, f.mime, b.size_bytes, u.login AS owner, f.taken_at FROM files f JOIN users u ON u.id = f.owner_id JOIN blobs b ON b.id = f.blob_id
       WHERE ${page} ORDER BY f.taken_at DESC, f.id DESC LIMIT ${add(o.limit + 1)}`,
      params,
    );
    const more = r.rows.length > o.limit;
    const rows = more ? r.rows.slice(0, o.limit) : r.rows;
    const last = rows[rows.length - 1];
    return {
      files: rows.map((x) => ({ id: x.id, name: x.name, mime: x.mime, size: Number(x.size_bytes), owner: x.owner, takenAt: x.taken_at.toISOString() })),
      next: more && last ? `${last.taken_at.toISOString()}_${last.id}` : null,
      total,
    };
  }

  // Карточка файла для просмотрщика админки: сведения, альбомы, у кого ещё лежит, соседи в том же порядке и под тем же фильтром.
  // prev: новее (стоит левее в списке), next: старее.
  async fileInfo(fileId: string, o: { login?: string; from?: string; to?: string; q?: string; albumId?: string }): Promise<{
    file: AdminFile & { width: number | null; height: number | null; sha256: string; createdAt: string; blobId: string };
    albums: { id: string; name: string; owner: string }[];
    copies: string[];
    prev: string | null;
    next: string | null;
    evidence: DateEvidence;
  }> {
    if (!ID_RE.test(fileId)) throw new NotFoundException('Файл не найден');
    const r = (await this.db.query<{ id: string; name: string; mime: string; size_bytes: string; owner: string; taken_at: Date; created_at: Date; sha256: string; blob_id: string; width: number | null; height: number | null; path: string; taken_manual: boolean }>(
      `SELECT f.id, f.original_name AS name, f.mime, b.size_bytes, u.login AS owner, f.taken_at, f.created_at, b.sha256, b.id AS blob_id, p.width, p.height, b.path, f.taken_manual
       FROM files f JOIN users u ON u.id = f.owner_id JOIN blobs b ON b.id = f.blob_id LEFT JOIN file_fingerprints p ON p.file_id = f.id
       WHERE f.id = $1 AND f.trashed_at IS NULL`, [fileId])).rows[0];
    if (!r) throw new NotFoundException('Файл не найден');
    const albums = (await this.db.query<{ id: string; name: string; owner: string }>(
      `SELECT a.id, a.name, u.login AS owner FROM album_items ai JOIN albums a ON a.id = ai.album_id JOIN users u ON u.id = a.owner_id WHERE ai.file_id = $1 AND a.deleted_at IS NULL ORDER BY a.name`, [fileId])).rows;
    const copies = (await this.db.query<{ login: string }>(
      `SELECT DISTINCT u.login FROM files f JOIN users u ON u.id = f.owner_id WHERE f.blob_id = $1 AND f.id <> $2 AND f.trashed_at IS NULL ORDER BY u.login`, [r.blob_id, fileId])).rows.map((x) => x.login);
    const side = async (cmp: '<' | '>'): Promise<string | null> => {
      const params: unknown[] = [];
      const where = await this.browseWhere(o, params);
      params.push(r.taken_at.toISOString(), r.id);
      const n = params.length;
      const q = await this.db.query<{ id: string }>(
        `SELECT f.id FROM files f JOIN users u ON u.id = f.owner_id WHERE ${where} AND (f.taken_at, f.id) ${cmp} ($${n - 1}::timestamptz, $${n}::bigint)
         ORDER BY f.taken_at ${cmp === '<' ? 'DESC' : 'ASC'}, f.id ${cmp === '<' ? 'DESC' : 'ASC'} LIMIT 1`, params);
      return q.rows[0]?.id ?? null;
    };
    return {
      file: { id: r.id, name: r.name, mime: r.mime, size: Number(r.size_bytes), owner: r.owner, takenAt: r.taken_at.toISOString(), width: r.width, height: r.height, sha256: r.sha256, createdAt: r.created_at.toISOString(), blobId: r.blob_id },
      albums,
      copies,
      prev: await side('>'),
      next: await side('<'),
      evidence: await dateEvidence({ abs: this.storage.abs(r.path), mime: r.mime, name: r.name, tz: (await this.settings.get()).timezone, manual: r.taken_manual }),
    };
  }

  // Администратор исправляет дату снимка (жалоба человека). Такая дата больше не перезаписывается пересчётом дат.
  async setTaken(fileId: string, iso: unknown): Promise<string> {
    if (!ID_RE.test(fileId)) throw new NotFoundException('Файл не найден');
    const d = typeof iso === 'string' ? new Date(iso) : new Date(NaN);
    if (!Number.isFinite(d.getTime()) || d.getUTCFullYear() < 1990 || d.getTime() > Date.now() + 86_400_000) throw new BadRequestException('Дата: от 1990 года и не позже завтрашнего дня');
    const r = await this.db.query('UPDATE files SET taken_at = $2, taken_manual = true WHERE id = $1', [fileId, d]);
    if (!r.rowCount) throw new NotFoundException('Файл не найден');
    return d.toISOString();
  }

  // Где лежит содержимое файла (для показа админу): путь в хранилище, тип и номер содержимого.
  async blobOf(fileId: string): Promise<{ path: string; mime: string; blobId: string; name: string } | null> {
    if (!ID_RE.test(fileId)) return null;
    const r = await this.db.query<{ path: string; mime: string; blob_id: string; name: string }>('SELECT b.path, b.mime, b.id AS blob_id, f.original_name AS name FROM files f JOIN blobs b ON b.id = f.blob_id WHERE f.id = $1', [fileId]);
    return r.rows[0] ? { path: r.rows[0].path, mime: r.rows[0].mime, blobId: r.rows[0].blob_id, name: r.rows[0].name } : null;
  }

  get root(): string {
    return this.storage.root;
  }

  abs(rel: string): string {
    return this.storage.abs(rel);
  }

  // ---- Общий доступ к альбомам (раздача из админки) ----

  async albumShares(albumId: string): Promise<string[]> {
    if (!ID_RE.test(albumId)) throw new NotFoundException('Альбом не найден');
    const r = await this.db.query<{ login: string }>('SELECT u.login FROM album_shares s JOIN users u ON u.id = s.user_id WHERE s.album_id = $1 ORDER BY u.login', [albumId]);
    return r.rows.map((x) => x.login);
  }

  async setShare(albumId: string, login: string, on: boolean): Promise<void> {
    if (!ID_RE.test(albumId)) throw new NotFoundException('Альбом не найден');
    const a = (await this.db.query<{ owner_id: string }>('SELECT owner_id FROM albums WHERE id = $1', [albumId])).rows[0];
    if (!a) throw new NotFoundException('Альбом не найден');
    const u = (await this.db.query<{ id: string }>('SELECT id FROM users WHERE login = $1', [login])).rows[0];
    if (!u) throw new NotFoundException('Нет такого человека');
    if (u.id === a.owner_id) throw new BadRequestException('Это альбом самого человека, ему делиться не нужно');
    if (on) await this.db.query('INSERT INTO album_shares (album_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [albumId, u.id]);
    else await this.db.query('DELETE FROM album_shares WHERE album_id = $1 AND user_id = $2', [albumId, u.id]);
  }

  // Скрыть альбом у всех: снять все доступы. Сам альбом и его файлы у хозяина остаются. Возвращает, сколько доступов снято.
  async unshareAll(albumId: string): Promise<number> {
    if (!ID_RE.test(albumId)) throw new NotFoundException('Альбом не найден');
    if (!(await this.db.query('SELECT 1 FROM albums WHERE id = $1 AND deleted_at IS NULL', [albumId])).rowCount) throw new NotFoundException('Альбом не найден');
    return (await this.db.query('DELETE FROM album_shares WHERE album_id = $1', [albumId])).rowCount ?? 0;
  }

  // Открыть альбом всем действующим людям, кроме хозяина. Возвращает, сколько новых доступов создано.
  async shareWithAll(albumId: string): Promise<number> {
    if (!ID_RE.test(albumId)) throw new NotFoundException('Альбом не найден');
    if (!(await this.db.query('SELECT 1 FROM albums WHERE id = $1 AND deleted_at IS NULL', [albumId])).rowCount) throw new NotFoundException('Альбом не найден');
    const r = await this.db.query('INSERT INTO album_shares (album_id, user_id) SELECT a.id, u.id FROM albums a CROSS JOIN users u WHERE a.id = $1 AND u.id <> a.owner_id AND NOT u.disabled ON CONFLICT DO NOTHING', [albumId]);
    return r.rowCount ?? 0;
  }

  // Каждый альбом каждого человека открыть всем остальным: «чтобы в семье все видели альбомы друг друга».
  async shareEverything(): Promise<{ albums: number; links: number }> {
    const albums = Number((await this.db.query<{ n: string }>('SELECT count(*) AS n FROM albums WHERE deleted_at IS NULL')).rows[0].n);
    const r = await this.db.query('INSERT INTO album_shares (album_id, user_id) SELECT a.id, u.id FROM albums a CROSS JOIN users u WHERE a.deleted_at IS NULL AND u.id <> a.owner_id AND NOT u.disabled ON CONFLICT DO NOTHING');
    return { albums, links: r.rowCount ?? 0 };
  }

  // ---- Альбомы ----

  async albums(): Promise<AdminAlbum[]> {
    const r = await this.db.query<{ id: string; name: string; owner: string; n: string; shared: string; in_library: boolean; in_photos: boolean; in_videos: boolean; in_screenshots: boolean; kind: 'any' | 'photos' | 'videos' | 'screenshots' }>(
      `SELECT a.id, a.name, u.login AS owner, a.in_library, a.in_photos, a.in_videos, a.in_screenshots, a.kind,
         (SELECT count(*) FROM album_items ai JOIN files f ON f.id = ai.file_id WHERE ai.album_id = a.id AND f.trashed_at IS NULL) AS n,
         (SELECT count(*) FROM album_shares s WHERE s.album_id = a.id) AS shared
       FROM albums a JOIN users u ON u.id = a.owner_id WHERE a.deleted_at IS NULL ORDER BY u.login, lower(a.name)`,
    );
    return r.rows.map((x) => ({ id: x.id, name: x.name, owner: x.owner, count: Number(x.n), sharedWith: Number(x.shared), show: { library: x.in_library, photos: x.in_photos, videos: x.in_videos, screenshots: x.in_screenshots }, kind: x.kind }));
  }

  // Альбомы, которые люди удалили у себя. Файлы в них никуда не делись: они в библиотеках хозяев. Здесь можно вернуть альбом или стереть его насовсем.
  async deletedAlbums(): Promise<AdminAlbum[]> {
    const r = await this.db.query<{ id: string; name: string; owner: string; n: string; shared: string; deleted_at: Date }>(
      `SELECT a.id, a.name, u.login AS owner, a.deleted_at,
         (SELECT count(*) FROM album_items ai JOIN files f ON f.id = ai.file_id WHERE ai.album_id = a.id AND f.trashed_at IS NULL) AS n,
         (SELECT count(*) FROM album_shares s WHERE s.album_id = a.id) AS shared
       FROM albums a JOIN users u ON u.id = a.owner_id WHERE a.deleted_at IS NOT NULL ORDER BY a.deleted_at DESC, a.id DESC`,
    );
    return r.rows.map((x) => ({ id: x.id, name: x.name, owner: x.owner, count: Number(x.n), sharedWith: Number(x.shared), deletedAt: x.deleted_at.toISOString() }));
  }

  // Вернуть удалённый альбом хозяину. Если за это время у него появился альбом с таким же названием, возвращаем под другим именем.
  async restoreAlbum(albumId: string): Promise<{ name: string }> {
    if (!ID_RE.test(albumId)) throw new NotFoundException('Альбом не найден');
    const a = (await this.db.query<{ name: string; owner_id: string }>('SELECT name, owner_id FROM albums WHERE id = $1 AND deleted_at IS NOT NULL', [albumId])).rows[0];
    if (!a) throw new NotFoundException('Удалённого альбома с таким номером нет');
    let name = a.name;
    const taken = async (n: string) => (await this.db.query('SELECT 1 FROM albums WHERE owner_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL', [a.owner_id, n])).rowCount! > 0;
    for (let i = 2; await taken(name); i++) name = `${a.name} (${i})`.slice(0, 100);
    await this.db.query('UPDATE albums SET deleted_at = NULL, name = $2 WHERE id = $1', [albumId, name]);
    return { name };
  }

  // Стереть удалённый альбом насовсем: пропадает только сам альбом (состав и доступы), файлы людей остаются.
  async purgeAlbum(albumId: string): Promise<void> {
    if (!ID_RE.test(albumId)) throw new NotFoundException('Альбом не найден');
    const r = await this.db.query('DELETE FROM albums WHERE id = $1 AND deleted_at IS NOT NULL', [albumId]);
    if (!r.rowCount) throw new NotFoundException('Удалённого альбома с таким номером нет');
  }

  // Удалить альбом целиком (только сам альбом, его состав и общий доступ; файлы людей остаются).
  async deleteAlbum(albumId: string): Promise<void> {
    if (!ID_RE.test(albumId)) throw new NotFoundException('Альбом не найден');
    const r = await this.db.query('DELETE FROM albums WHERE id = $1', [albumId]);
    if (!r.rowCount) throw new NotFoundException('Альбом не найден');
  }

  // Что случится при смене хозяина: сколько файлов уйдёт и сколько из них лежит ещё и в других альбомах прежнего хозяина.
  async transferPreview(albumId: string): Promise<{ files: number; inOtherAlbums: number; owner: string }> {
    if (!ID_RE.test(albumId)) throw new NotFoundException('Альбом не найден');
    const a = (await this.db.query<{ owner: string }>('SELECT u.login AS owner FROM albums a JOIN users u ON u.id = a.owner_id WHERE a.id = $1 AND a.deleted_at IS NULL', [albumId])).rows[0];
    if (!a) throw new NotFoundException('Альбом не найден');
    const r = (await this.db.query<{ n: string; o: string }>(
      `SELECT count(*) AS n, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM album_items x WHERE x.file_id = f.id AND x.album_id <> $1)) AS o
       FROM files f JOIN album_items ai ON ai.file_id = f.id WHERE ai.album_id = $1 AND f.trashed_at IS NULL AND f.blob_id IS NOT NULL`, [albumId])).rows[0];
    return { files: Number(r.n), inOtherAlbums: Number(r.o), owner: a.owner };
  }

  // Перенос альбома другому человеку без копирования файлов: у получателя появляются свои записи на те же файлы.
  // move=false: у прежнего хозяина альбом остаётся; move=true: смена хозяина. Альбом и записи о его файлах исчезают
  // у прежнего хозяина полностью (в том числе из других его альбомов), файлы на диске остаются и считаются в место получателя.
  async transferAlbum(albumId: string, toLogin: string, move: boolean): Promise<{ albumId: string; linked: number; removedFromOwner: number }> {
    if (!ID_RE.test(albumId)) throw new NotFoundException('Альбом не найден');
    const a = (await this.db.query<{ id: string; name: string; owner_id: string; kind: string }>('SELECT id, name, owner_id, kind FROM albums WHERE id = $1 AND deleted_at IS NULL', [albumId])).rows[0];
    if (!a) throw new NotFoundException('Альбом не найден');
    const to = (await this.db.query<{ id: string }>('SELECT id FROM users WHERE login = $1', [toLogin])).rows[0];
    if (!to) throw new NotFoundException('Нет такого человека');
    if (to.id === a.owner_id) throw new BadRequestException('Альбом уже у этого человека');
    const files = (await this.db.query<FileRow>(
      `SELECT f.* FROM files f JOIN album_items ai ON ai.file_id = f.id WHERE ai.album_id = $1 AND f.trashed_at IS NULL AND f.blob_id IS NOT NULL ORDER BY f.taken_at, f.id`,
      [albumId],
    )).rows;
    let name = a.name;
    const taken = async (n: string) => (await this.db.query('SELECT 1 FROM albums WHERE owner_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL', [to.id, n])).rows.length > 0;
    for (let i = 2; await taken(name); i++) name = `${a.name} (${i})`;
    const created = (await this.db.query<{ id: string }>('INSERT INTO albums (owner_id, name, kind) VALUES ($1, $2, $3) RETURNING id', [to.id, name, a.kind])).rows[0];
    let linked = 0;
    for (const f of files) {
      const b = (await this.db.query<BlobRow>('SELECT * FROM blobs WHERE id = $1', [f.blob_id])).rows[0];
      if (!b) continue;
      const mine = await this.link(to.id, b, f.original_name, f.taken_at);
      await this.db.query('INSERT INTO album_items (album_id, file_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [created.id, mine.id]);
      linked++;
    }
    let removedFromOwner = 0;
    if (move) {
      await this.db.query('DELETE FROM albums WHERE id = $1', [albumId]);
      for (const f of files) {
        const d = await this.db.query('DELETE FROM files WHERE id = $1 AND owner_id = $2', [f.id, a.owner_id]);
        if (d.rowCount) {
          removedFromOwner++;
          await this.removeLegacyDerived(f);
        }
      }
    }
    return { albumId: created.id, linked, removedFromOwner };
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
    const blobs = (await this.db.query<{ blob_id: string; name: string; taken: Date }>('SELECT blob_id, min(original_name) AS name, min(taken_at) AS taken FROM files WHERE owner_id = $1 AND blob_id IS NOT NULL GROUP BY blob_id', [u.id])).rows;
    await this.db.query('DELETE FROM albums WHERE owner_id = $1', [u.id]);
    await this.db.query('DELETE FROM files WHERE owner_id = $1', [u.id]);
    for (const b of blobs) {
      await this.db.query(
        'UPDATE blobs SET orphaned_at = now(), orphan_note = $2, orphan_name = $3, orphan_taken_at = $4 WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM files f WHERE f.blob_id = $1)',
        [b.blob_id, `Аккаунт ${login} удалён администратором`, b.name, b.taken],
      );
    }
    for (const l of links) await this.removeLegacyDerived(l); // общие миниатюры остаются у файлов-оригиналов
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

  // ---- Сейф ----

  private async refuseIfVault(blobId: string): Promise<void> {
    const v = await this.db.query('SELECT 1 FROM vault_items WHERE blob_id = $1 LIMIT 1', [blobId]);
    if (v.rows[0]) throw new ConflictException('Файл лежит в сейфе: стереть его можно только из панели «Сейф» после ввода пароля');
  }

  async vaultList(): Promise<{ id: string; name: string; note: string; fromLogin: string; count: number; bytes: number; createdAt: string}[]> {
    const r = await this.db.query<{ id: string; name: string; note: string; from_login: string; created_at: Date; n: string; bytes: string }>(
      `SELECT v.id, v.name, v.note, v.from_login, v.created_at,
              (SELECT count(*) FROM vault_items i WHERE i.vault_album_id = v.id) AS n,
              (SELECT COALESCE(sum(b.size_bytes), 0) FROM vault_items i JOIN blobs b ON b.id = i.blob_id WHERE i.vault_album_id = v.id) AS bytes
       FROM vault_albums v ORDER BY v.created_at DESC, v.id DESC`,
    );
    return r.rows.map((x) => ({ id: x.id, name: x.name, note: x.note, fromLogin: x.from_login, count: Number(x.n), bytes: Number(x.bytes), createdAt: x.created_at.toISOString() }));
  }

  // Забрать альбом у владельца вместе с файлами: у человека исчезают и альбом, и записи о файлах (место освобождается),
  // а сами файлы остаются на диске без владельца в сейфе. Файл, который лежит ещё и у другого человека, у того остаётся.
  async toVault(albumId: string, note: unknown): Promise<{ vaultId: string; files: number }> {
    if (!ID_RE.test(albumId)) throw new NotFoundException('Альбом не найден');
    const text = typeof note === 'string' ? note.trim().slice(0, 300) : '';
    return this.db.tx(async (c) => {
      const a = (await c.query<{ id: string; name: string; login: string }>('SELECT a.id, a.name, u.login FROM albums a JOIN users u ON u.id = a.owner_id WHERE a.id = $1 FOR UPDATE OF a', [albumId])).rows[0];
      if (!a) throw new NotFoundException('Альбом не найден');
      const items = (await c.query<{ id: string; blob_id: string; original_name: string; taken_at: Date }>(
        'SELECT f.id, f.blob_id, f.original_name, f.taken_at FROM album_items ai JOIN files f ON f.id = ai.file_id WHERE ai.album_id = $1 AND f.blob_id IS NOT NULL ORDER BY f.taken_at, f.id', [albumId])).rows;
      if (items.length === 0) throw new ConflictException('В альбоме нет файлов: нечего класть в сейф');
      const v = (await c.query<{ id: string }>('INSERT INTO vault_albums (name, note, from_login) VALUES ($1, $2, $3) RETURNING id', [a.name, text, a.login])).rows[0];
      for (const it of items) {
        await c.query('INSERT INTO vault_items (vault_album_id, blob_id, name, taken_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [v.id, it.blob_id, it.original_name, it.taken_at]);
      }
      await c.query('DELETE FROM files WHERE id = ANY($1::bigint[])', [items.map((i) => i.id)]);
      await c.query('DELETE FROM albums WHERE id = $1', [albumId]);
      await c.query('UPDATE blobs SET orphaned_at = NULL, orphan_note = NULL WHERE id = ANY($1::bigint[])', [items.map((i) => i.blob_id)]);
      return { vaultId: v.id, files: items.length };
    });
  }

  // Вернуть альбом из сейфа человеку: у него появляется альбом (с суффиксом, если такое имя занято) и записи о файлах.
  async vaultReturn(vaultId: string, login: unknown): Promise<{ albumId: string; linked: number }> {
    if (!ID_RE.test(vaultId)) throw new NotFoundException('Альбом в сейфе не найден');
    if (typeof login !== 'string') throw new BadRequestException('login: кому вернуть');
    return this.db.tx(async (c) => {
      const v = (await c.query<{ id: string; name: string }>('SELECT id, name FROM vault_albums WHERE id = $1 FOR UPDATE', [vaultId])).rows[0];
      if (!v) throw new NotFoundException('Альбом в сейфе не найден');
      const u = (await c.query<{ id: string }>('SELECT id FROM users WHERE login = $1 AND NOT disabled', [login])).rows[0];
      if (!u) throw new NotFoundException('Нет такого человека');
      let name = v.name;
      for (let n = 2; (await c.query('SELECT 1 FROM albums WHERE owner_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL', [u.id, name])).rows[0]; n++) name = `${v.name.slice(0, 90)} (${n})`;
      const album = (await c.query<{ id: string }>('INSERT INTO albums (owner_id, name) VALUES ($1, $2) RETURNING id', [u.id, name])).rows[0];
      const items = (await c.query<{ blob_id: string; name: string; taken_at: Date; path: string; mime: string; size_bytes: string; sha256: string }>(
        'SELECT i.blob_id, i.name, i.taken_at, b.path, b.mime, b.size_bytes, b.sha256 FROM vault_items i JOIN blobs b ON b.id = i.blob_id WHERE i.vault_album_id = $1 ORDER BY i.taken_at', [vaultId])).rows;
      let linked = 0;
      for (const it of items) {
        await c.query(
          `INSERT INTO files (owner_id, path, original_name, mime, size_bytes, sha256, taken_at, blob_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (owner_id, sha256) WHERE trashed_at IS NULL DO NOTHING`,
          [u.id, it.path, it.name, it.mime, it.size_bytes, it.sha256, it.taken_at, it.blob_id],
        );
        const f = (await c.query<{ id: string }>('SELECT id FROM files WHERE owner_id = $1 AND sha256 = $2 AND trashed_at IS NULL', [u.id, it.sha256])).rows[0];
        if (f) {
          await c.query('INSERT INTO album_items (album_id, file_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [album.id, f.id]);
          linked++;
        }
      }
      await c.query('DELETE FROM vault_albums WHERE id = $1', [vaultId]); // записи vault_items уходят каскадом, файлы остаются у человека
      return { albumId: album.id, linked };
    });
  }

  // Стереть альбом из сейфа насовсем. С диска уходят только файлы, которых нет ни у одного человека и ни в другом альбоме сейфа.
  async vaultErase(vaultId: string): Promise<{ files: number; bytes: number; kept: number }> {
    if (!ID_RE.test(vaultId)) throw new NotFoundException('Альбом в сейфе не найден');
    const blobs = (await this.db.query<BlobRow>('SELECT b.* FROM vault_items i JOIN blobs b ON b.id = i.blob_id WHERE i.vault_album_id = $1', [vaultId])).rows;
    const gone = await this.db.query('DELETE FROM vault_albums WHERE id = $1', [vaultId]);
    if (!gone.rowCount) throw new NotFoundException('Альбом в сейфе не найден');
    let files = 0, bytes = 0, kept = 0;
    for (const b of blobs) {
      const extra = (await this.db.query<{ path: string }>('SELECT path FROM blob_extra_paths WHERE blob_id = $1', [b.id])).rows.map((x) => x.path);
      const del = await this.db.query(
        'DELETE FROM blobs b WHERE b.id = $1 AND NOT EXISTS (SELECT 1 FROM files f WHERE f.blob_id = b.id) AND NOT EXISTS (SELECT 1 FROM vault_items v WHERE v.blob_id = b.id)', [b.id]);
      if (!del.rowCount) { kept++; continue; }
      for (const p of new Set<string>([b.path, ...extra])) await this.storage.remove(p);
      await this.storage.remove(`videos/${b.id}.mp4`);
      await this.removeDerived(b.id, []);
      files++;
      bytes += Number(b.size_bytes);
    }
    return { files, bytes, kept };
  }
}
