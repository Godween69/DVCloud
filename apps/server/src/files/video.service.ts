import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DbService } from '../db/db.service';
import { ActivityService } from './activity.service';
import { FileRow } from './files.service';
import { MediaSettings, MediaSettingsService, videoParams } from './media-settings';
import { StorageService } from './storage.service';

export const videoCopyRel = (blobId: string): string => `videos/${blobId}.mp4`;

// Копии видео «для просмотра» (H.264, меньший размер кадра, быстрый старт). Делаются в фоне, по одному ролику,
// с низким приоритетом и только когда нет загрузок. Оригинал не меняется; копия одна на физический файл.
@Injectable()
export class VideoService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(MediaSettingsService) private readonly settings: MediaSettingsService,
  ) {}

  onModuleInit(): void {
    const ms = Number(process.env.DVCLOUD_VIDEO_TICK_MS ?? 30_000);
    this.timer = setInterval(() => void this.tick(), Number.isFinite(ms) && ms >= 100 ? ms : 30_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
  }

  // Путь к готовой копии для просмотра или null (копии нет, она устарела или функция выключена).
  async copyFor(f: Pick<FileRow, 'blob_id' | 'mime'>): Promise<string | null> {
    if (!f.blob_id || !f.mime.startsWith('video/')) return null;
    const s = await this.settings.get();
    if (!s.videoEnabled) return null;
    const r = await this.db.query<{ params: string }>("SELECT params FROM video_copies WHERE blob_id = $1 AND status = 'ready'", [f.blob_id]);
    if (!r.rows[0] || r.rows[0].params !== videoParams(s)) return null;
    const rel = videoCopyRel(f.blob_id);
    try {
      await stat(this.storage.abs(rel));
      return rel;
    } catch {
      return null;
    }
  }

  // Один проход: берёт ролики без актуальной копии по очереди, пока включено и нет загрузок.
  async tick(): Promise<void> {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      for (;;) {
        const s = await this.settings.get(true);
        if (!s.videoEnabled || this.activity.busy() || this.stopping) return;
        const next = (
          await this.db.query<{ id: string; path: string; size_bytes: string }>(
            `SELECT b.id, b.path, b.size_bytes FROM blobs b LEFT JOIN video_copies v ON v.blob_id = b.id
             WHERE b.mime LIKE 'video/%' AND (v.blob_id IS NULL OR v.params <> $1) AND EXISTS (SELECT 1 FROM files f WHERE f.blob_id = b.id)
             ORDER BY b.id LIMIT 1`,
            [videoParams(s)],
          )
        ).rows[0];
        if (!next) return;
        await this.convert(next, s);
      }
    } catch {
      /* следующий проход попробует снова */
    } finally {
      this.running = false;
    }
  }

  private codec(file: string): Promise<string> {
    return new Promise((resolve) => {
      let out = '';
      const p = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file], { stdio: ['ignore', 'pipe', 'ignore'] });
      p.stdout.on('data', (c: Buffer) => (out += c.toString()));
      p.on('error', () => resolve('h264'));
      p.on('close', () => resolve(out.trim() || 'h264'));
    });
  }

  private async convert(b: { id: string; path: string; size_bytes: string }, s: MediaSettings): Promise<void> {
    const rel = videoCopyRel(b.id);
    const out = this.storage.abs(rel);
    const tmp = `${out}.${process.pid}.tmp.mp4`;
    await mkdir(dirname(out), { recursive: true });
    const params = videoParams(s);
    const save = (status: 'ready' | 'skipped' | 'failed', size: number, error: string | null) =>
      this.db.query(
        `INSERT INTO video_copies (blob_id, status, params, size_bytes, error) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (blob_id) DO UPDATE SET status = EXCLUDED.status, params = EXCLUDED.params, size_bytes = EXCLUDED.size_bytes, error = EXCLUDED.error, updated_at = now()`,
        [b.id, status, params, size, error],
      );
    // Кадр не увеличиваем: min(целевая высота, исходная). Запятая в выражении экранирована для ffmpeg.
    const ff = [
      '-nostdin', '-v', 'error', '-i', this.storage.abs(b.path), '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', `scale=-2:min(${s.videoHeight}\\,ih)`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(s.videoCrf), '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-threads', '2', '-movflags', '+faststart', '-f', 'mp4', '-y', tmp,
    ];
    const err = await new Promise<string | null>((resolve) => {
      let log = '';
      const p = spawn('nice', ['-n', '19', 'ffmpeg', ...ff], { stdio: ['ignore', 'ignore', 'pipe'] });
      p.stderr.on('data', (c: Buffer) => {
        log = (log + c.toString()).slice(-600);
      });
      const watch = setInterval(() => {
        // Выключили в админке или останавливаемся: прерываем работу.
        void this.settings.get(true).then((cur) => {
          if (!cur.videoEnabled || videoParams(cur) !== params || this.stopping) p.kill('SIGKILL');
        }).catch(() => undefined);
      }, 10_000);
      const limit = setTimeout(() => p.kill('SIGKILL'), 6 * 3600_000);
      p.on('error', (e) => {
        clearInterval(watch);
        clearTimeout(limit);
        resolve(`не запустился ffmpeg: ${e.message}`);
      });
      p.on('close', (code, sig) => {
        clearInterval(watch);
        clearTimeout(limit);
        resolve(code === 0 ? null : sig ? 'прервано' : log.trim() || `код ${code}`);
      });
    });
    if (err === 'прервано') {
      await rm(tmp, { force: true });
      return; // не помечаем: при следующем проходе ролик возьмётся снова, если настройки позволят
    }
    if (err) {
      await rm(tmp, { force: true });
      await save('failed', 0, err.slice(0, 300));
      return;
    }
    const size = (await stat(tmp)).size;
    // Копию не оставляем, только если оригинал уже H.264 и копия не меньше его: браузер играет оригинал.
    // HEVC, MJPEG и прочее браузеры часто не показывают (картинки нет, звук есть), для них копия нужна всегда.
    if (size >= Number(b.size_bytes) * 0.9 && (await this.codec(this.storage.abs(b.path))) === 'h264') {
      await rm(tmp, { force: true }); // выгоды нет: оригинал уже компактный
      await save('skipped', 0, null);
      return;
    }
    await rename(tmp, out);
    await save('ready', size, null);
  }
}
