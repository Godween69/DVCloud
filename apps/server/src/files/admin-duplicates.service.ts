import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { rm } from 'node:fs/promises';
import { DbService } from '../db/db.service';
import { ActivityService } from './activity.service';
import { ID_RE } from './files.service';
import { StorageService } from './storage.service';
import { DEFAULT_DUP, Item, findDuplicates, rankForQuality } from './similar';

// Дубликаты по всему хранилищу (для админа). Дубликат: тот же кадр в другом разрешении или после пережатия
// (например, фото из мессенджера и оригинал). Серии похожих кадров сюда не входят: они только у людей на сайте.
// Сравниваются файлы-оригиналы на диске (blobs), а не записи людей: одно и то же содержимое у двух людей это один файл.
// Поиск идёт в фоне, пока нет загрузок, и обновляется сам; результат хранится в памяти.

export interface DupBlob {
  blobId: string;
  fileId: string; // любая запись, по ней показывается миниатюра
  width: number;
  height: number;
  size: number;
  keep: boolean; // предложено оставить: больше всего пикселей, потом размер
  owners: { login: string; files: number }[];
}
export interface DupGroup {
  id: string;
  blobs: DupBlob[]; // лучший первым
  reclaimBytes: number; // сколько освободится, если оставить только лучший
}
export interface DupReport {
  computedAt: string | null;
  scanning: boolean;
  groups: DupGroup[];
  totalGroups: number;
  reclaimBytes: number;
}

interface Row {
  blob_id: string;
  file_id: string;
  dhash: Buffer;
  tiny: Buffer;
  width: number;
  height: number;
  sharpness: number;
  size_bytes: string;
  taken_at: Date;
}

const MAX_SHOWN = 100;
const MAX_MERGE = 50;

@Injectable()
export class AdminDuplicatesService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Duplicates');
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;
  private computedAt: Date | null = null;
  private groups: DupGroup[] = [];
  private total = 0;
  private reclaim = 0;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(ActivityService) private readonly activity: ActivityService,
  ) {}

  // Первый поиск через минуту после запуска, дальше раз в несколько часов (по умолчанию 6) и после каждого слияния.
  onModuleInit(): void {
    if (process.env.DVCLOUD_NO_DUP_SCAN === '1') return;
    const ms = Number(process.env.DVCLOUD_DUP_SCAN_MS ?? 6 * 3600_000);
    const every = Number.isFinite(ms) && ms >= 1000 ? ms : 6 * 3600_000;
    const first = setTimeout(() => this.request(), Math.min(60_000, every));
    first.unref();
    this.timer = setInterval(() => this.request(), every);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // Поставить поиск в очередь фоновой работы (не мешает загрузкам).
  request(): void {
    if (this.scanning) return;
    this.activity.defer(() => this.scan());
  }

  report(): DupReport {
    return { computedAt: this.computedAt ? this.computedAt.toISOString() : null, scanning: this.scanning, groups: this.groups, totalGroups: this.total, reclaimBytes: this.reclaim };
  }

  private async load(only?: string[]): Promise<{ rows: Map<string, Row>; items: Item[] }> {
    const r = await this.db.query<Row>(
      `SELECT DISTINCT ON (f.blob_id) f.blob_id, f.id AS file_id, p.dhash, p.tiny, p.width, p.height, p.sharpness, b.size_bytes, f.taken_at
       FROM files f JOIN file_fingerprints p ON p.file_id = f.id JOIN blobs b ON b.id = f.blob_id
       WHERE f.blob_id IS NOT NULL AND b.mime LIKE 'image/%' ${only ? 'AND f.blob_id = ANY($1::bigint[])' : ''}
       ORDER BY f.blob_id, f.id`,
      only ? [only] : [],
    );
    const rows = new Map<string, Row>();
    const items: Item[] = r.rows.map((x) => {
      rows.set(x.blob_id, x);
      return { id: x.blob_id, dhash: x.dhash, tiny: x.tiny, width: x.width, height: x.height, sharpness: x.sharpness, size: Number(x.size_bytes), takenAt: x.taken_at.getTime() };
    });
    return { rows, items };
  }

  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const { rows, items } = await this.load();
      const found = findDuplicates(items, DEFAULT_DUP).map((g) => rankForQuality(g));
      let reclaim = 0;
      const ranked = found
        .map((list) => ({ list, lost: list.slice(1).reduce((n, i) => n + i.size, 0) }))
        .sort((x, y) => y.lost - x.lost);
      for (const g of ranked) reclaim += g.lost;
      const top = ranked.slice(0, MAX_SHOWN);
      // Владельцев узнаём только для показанных групп.
      const ids = top.flatMap((g) => g.list.map((i) => i.id));
      const owners = ids.length
        ? (await this.db.query<{ blob_id: string; login: string; n: string }>(
            `SELECT f.blob_id, u.login, count(*) AS n FROM files f JOIN users u ON u.id = f.owner_id WHERE f.blob_id = ANY($1::bigint[]) GROUP BY f.blob_id, u.login ORDER BY u.login`,
            [ids],
          )).rows
        : [];
      const shown: DupGroup[] = top.map((g) => ({
        id: g.list.map((i) => i.id).sort((p, q) => Number(p) - Number(q))[0],
        reclaimBytes: g.lost,
        blobs: g.list.map((i, n) => {
          const x = rows.get(i.id)!;
          return {
            blobId: i.id, fileId: x.file_id, width: x.width, height: x.height, size: i.size, keep: n === 0,
            owners: owners.filter((o) => o.blob_id === i.id).map((o) => ({ login: o.login, files: Number(o.n) })),
          };
        }),
      }));
      this.groups = shown;
      this.total = ranked.length;
      this.reclaim = reclaim;
      this.computedAt = new Date();
      if (ranked.length > 0) this.log.log(`дубликатов по хранилищу: групп ${ranked.length}, можно освободить ${Math.round(reclaim / 1048576)} МБ`);
    } catch (e) {
      this.log.warn(`поиск дубликатов не удался: ${(e as Error).message}`);
    } finally {
      this.scanning = false;
    }
  }

  // Слияние: в группе остаётся один файл (keep), записи людей на остальные переключаются на него, лишние файлы стираются с диска.
  // Ничего не пропадает у людей: названия, даты съёмки и альбомы сохраняются. Если у человека уже есть живая запись на оставляемый файл,
  // запись на лишний файл убирается, а её альбомы переходят на уцелевшую.
  async merge(keepId: string, dropIds: unknown): Promise<{ merged: number; removedFiles: number; bytes: number }> {
    if (!ID_RE.test(keepId)) throw new NotFoundException('Файл не найден');
    if (!Array.isArray(dropIds) || dropIds.length < 1 || dropIds.length > MAX_MERGE || dropIds.some((x) => typeof x !== 'string' || !ID_RE.test(x))) {
      throw new BadRequestException(`drop: список от 1 до ${MAX_MERGE} номеров файлов`);
    }
    const drops = [...new Set(dropIds as string[])];
    if (drops.includes(keepId)) throw new BadRequestException('Оставляемый файл не может быть в списке удаляемых');
    // Проверяем заново, а не верим экрану: все файлы должны и сейчас считаться дубликатами друг друга.
    const { items } = await this.load([keepId, ...drops]);
    if (items.length !== drops.length + 1) throw new ConflictException('Часть файлов уже изменилась. Обновите список дубликатов');
    const groups = findDuplicates(items, DEFAULT_DUP);
    if (groups.length !== 1 || groups[0].length !== items.length) throw new ConflictException('Эти файлы уже не считаются дубликатами. Обновите список');

    const gone: { path: string; extra: string[]; id: string; size: number }[] = [];
    let merged = 0;
    let removedFiles = 0;
    await this.db.tx(async (c) => {
      const keep = (await c.query<{ id: string; path: string; mime: string; size_bytes: string; sha256: string }>('SELECT id, path, mime, size_bytes, sha256 FROM blobs WHERE id = $1 FOR UPDATE', [keepId])).rows[0];
      if (!keep) throw new NotFoundException('Оставляемый файл не найден');
      for (const d of drops) {
        const b = (await c.query<{ id: string; path: string; size_bytes: string }>('SELECT id, path, size_bytes FROM blobs WHERE id = $1 FOR UPDATE', [d])).rows[0];
        if (!b) throw new ConflictException('Файл уже стёрт. Обновите список');
        const extra = (await c.query<{ path: string }>('SELECT path FROM blob_extra_paths WHERE blob_id = $1', [d])).rows.map((x) => x.path);
        const links = (await c.query<{ id: string; owner_id: string; trashed_at: Date | null; path: string }>('SELECT id, owner_id, trashed_at, path FROM files WHERE blob_id = $1 FOR UPDATE', [d])).rows;
        const paths = new Set<string>([b.path, ...extra, ...links.map((l) => l.path)]);
        for (const l of links) {
          const live = l.trashed_at
            ? null
            : (await c.query<{ id: string }>('SELECT id FROM files WHERE owner_id = $1 AND sha256 = $2 AND trashed_at IS NULL AND id <> $3', [l.owner_id, keep.sha256, l.id])).rows[0];
          if (live) {
            await c.query('INSERT INTO album_items (album_id, file_id, added_at) SELECT album_id, $2, added_at FROM album_items WHERE file_id = $1 ON CONFLICT DO NOTHING', [l.id, live.id]);
            await c.query('UPDATE yandex_items SET file_id = $2 WHERE file_id = $1', [l.id, live.id]);
            await c.query('DELETE FROM files WHERE id = $1', [l.id]);
            removedFiles++;
          } else {
            await c.query('UPDATE files SET blob_id = $2, path = $3, mime = $4, size_bytes = $5, sha256 = $6 WHERE id = $1', [l.id, keep.id, keep.path, keep.mime, keep.size_bytes, keep.sha256]);
            await c.query('DELETE FROM file_fingerprints WHERE file_id = $1', [l.id]); // отпечаток пересчитается уже по оставленному файлу
            merged++;
          }
        }
        await c.query('DELETE FROM blobs WHERE id = $1', [d]);
        gone.push({ path: b.path, extra: [...paths].filter((p) => p !== keep.path), id: d, size: Number(b.size_bytes) });
      }
    });
    // Файлы с диска стираются только после того, как база приняла изменения.
    let bytes = 0;
    for (const g of gone) {
      for (const p of new Set([g.path, ...g.extra])) await this.storage.remove(p);
      await this.storage.remove(`videos/${g.id}.mp4`);
      await this.storage.remove(`thumbs/${g.id}.webp`);
      await this.storage.remove(`thumbs-fit/${g.id}.webp`);
      await this.storage.remove(`previews/${g.id}.webp`);
      await rm(this.storage.abs(`faces/${g.id}`), { recursive: true, force: true });
      bytes += g.size;
    }
    this.request(); // обновить список
    return { merged, removedFiles, bytes };
  }
}
