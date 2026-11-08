import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DbService } from '../db/db.service';
import { MediaSettings, MediaSettingsService, videoParams } from './media-settings';
import { StorageService } from './storage.service';
import { MlClient } from './ml-client';
import { IndexStats, indexStats } from './search-index';
import { detectTakenAt } from './taken';

export type ClearTarget = 'thumbs' | 'previews' | 'videos' | 'index' | 'index-failed';

export interface DirStat {
  files: number;
  bytes: number;
}

export interface MediaOverview {
  settings: MediaSettings;
  thumbs: DirStat;
  previews: DirStat;
  videos: { copies: DirStat; total: number; totalBytes: number; ready: number; skipped: number; failed: number; pending: number };
  search: IndexStats & { configured: boolean; up: boolean; modelFiles: boolean; model: string | null; sizeBytes: number };
}

export interface DatesJob {
  running: boolean;
  apply: boolean; // false: только проверка, ничего не меняется
  startedAt: string;
  finishedAt: string | null;
  total: number;
  checked: number;
  changed: number;
  examples: { name: string; before: string; after: string }[];
}

async function dirStat(dir: string): Promise<DirStat> {
  const out: DirStat = { files: 0, bytes: 0 };
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const s = await dirStat(p);
      out.files += s.files;
      out.bytes += s.bytes;
    } else {
      try {
        out.bytes += (await stat(p)).size;
        out.files++;
      } catch {
        /* файл исчез во время подсчёта */
      }
    }
  }
  return out;
}

// Настройки превью и видео, счётчики места и очистка производных файлов (миниатюры, превью, копии видео).
// Производные файлы можно удалить в любой момент: они строятся заново, оригиналы не затрагиваются.
@Injectable()
export class AdminMediaService {
  private job: DatesJob | null = null;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(MediaSettingsService) private readonly settings: MediaSettingsService,
    @Inject(MlClient) private readonly ml: MlClient,
  ) {}

  datesStatus(): DatesJob | null {
    return this.job;
  }

  // Пересчёт дат съёмки у уже загруженных файлов по метаданным и имени файла (см. taken.ts). Идёт в фоне по одному файлу.
  // apply=false: только считает, сколько дат изменилось, и показывает примеры.
  async startDates(apply: boolean): Promise<DatesJob> {
    if (this.job?.running) throw new ConflictException('Пересчёт уже идёт');
    const total = Number((await this.db.query<{ n: string }>('SELECT count(*) AS n FROM files')).rows[0].n);
    const job: DatesJob = { running: true, apply, startedAt: new Date().toISOString(), finishedAt: null, total, checked: 0, changed: 0, examples: [] };
    this.job = job;
    void this.runDates(job);
    return job;
  }

  private async runDates(job: DatesJob): Promise<void> {
    try {
      const tz = (await this.settings.get(true)).timezone;
      let last = '0';
      for (;;) {
        const rows = (
          await this.db.query<{ id: string; original_name: string; mime: string; path: string; taken_at: Date }>(
            'SELECT id, original_name, mime, path, taken_at FROM files WHERE id > $1 ORDER BY id LIMIT 200',
            [last],
          )
        ).rows;
        if (rows.length === 0) break;
        for (const f of rows) {
          last = f.id;
          job.checked++;
          try {
            const { date } = await detectTakenAt({ abs: this.storage.abs(f.path), mime: f.mime, name: f.original_name, tz });
            if (date && Math.abs(date.getTime() - f.taken_at.getTime()) > 1000) {
              job.changed++;
              if (job.examples.length < 8) job.examples.push({ name: f.original_name, before: f.taken_at.toISOString(), after: date.toISOString() });
              if (job.apply) await this.db.query('UPDATE files SET taken_at = $2 WHERE id = $1', [f.id, date]);
            }
          } catch {
            /* файл не читается: дату не трогаем */
          }
          await new Promise((r) => setImmediate(r)); // не занимать процессор надолго подряд
        }
      }
    } finally {
      job.running = false;
      job.finishedAt = new Date().toISOString();
    }
  }

  async overview(): Promise<MediaOverview> {
    const settings = await this.settings.get(true);
    const p = videoParams(settings);
    const r = await this.db.query<{ total: string; total_bytes: string; ready: string; skipped: string; failed: string; pending: string }>(
      `SELECT count(*) AS total, COALESCE(sum(b.size_bytes), 0) AS total_bytes,
              count(*) FILTER (WHERE v.status = 'ready' AND v.params = $1) AS ready,
              count(*) FILTER (WHERE v.status = 'skipped' AND v.params = $1) AS skipped,
              count(*) FILTER (WHERE v.status = 'failed' AND v.params = $1) AS failed,
              count(*) FILTER (WHERE v.blob_id IS NULL OR v.params <> $1) AS pending
       FROM blobs b LEFT JOIN video_copies v ON v.blob_id = b.id
       WHERE b.mime LIKE 'video/%' AND EXISTS (SELECT 1 FROM files f WHERE f.blob_id = b.id)`,
      [p],
    );
    const x = r.rows[0];
    const h = await this.ml.health();
    const size = Number((await this.db.query<{ n: string }>("SELECT COALESCE(sum(octet_length(vector)), 0) AS n FROM embeddings")).rows[0].n);
    return {
      settings,
      thumbs: await dirStat(this.storage.abs('thumbs')),
      previews: await dirStat(this.storage.abs('previews')),
      videos: {
        copies: await dirStat(this.storage.abs('videos')),
        total: Number(x.total),
        totalBytes: Number(x.total_bytes),
        ready: Number(x.ready),
        skipped: Number(x.skipped),
        failed: Number(x.failed),
        pending: Number(x.pending),
      },
      search: { ...(await indexStats(this.db, h?.model ?? null)), configured: this.ml.configured, up: h !== null, modelFiles: h?.ready ?? false, model: h?.model ?? null, sizeBytes: size },
    };
  }

  // Сохраняет настройки. Если поменялись параметры, от которых зависят готовые файлы, они стираются и строятся заново.
  async save(patch: Partial<MediaSettings>): Promise<{ settings: MediaSettings; cleared: ClearTarget[] }> {
    const { before, after } = await this.settings.save(patch);
    const cleared: ClearTarget[] = [];
    if (before.previewMaxSide !== after.previewMaxSide || before.previewQuality !== after.previewQuality) {
      await this.clear('previews');
      cleared.push('previews');
    }
    if (before.videoHeight !== after.videoHeight || before.videoCrf !== after.videoCrf) {
      await this.clear('videos');
      cleared.push('videos');
    }
    return { settings: after, cleared };
  }

  async clear(what: string): Promise<DirStat> {
    if (what === 'index' || what === 'index-failed') {
      // Векторы стираются только в базе; пересчитываются в фоне, пока поиск включён. «index-failed» стирает лишь неудачные записи.
      const r = await this.db.query(what === 'index' ? 'DELETE FROM embeddings' : "DELETE FROM embeddings WHERE status = 'failed'");
      return { files: r.rowCount ?? 0, bytes: 0 };
    }
    if (what !== 'thumbs' && what !== 'previews' && what !== 'videos') throw new BadRequestException('Очистить можно: thumbs, previews, videos, index или index-failed');
    const before = await dirStat(this.storage.abs(what));
    await rm(this.storage.abs(what), { recursive: true, force: true });
    await mkdir(this.storage.abs(what), { recursive: true });
    if (what === 'videos') await this.db.query('DELETE FROM video_copies');
    return before;
  }
}
