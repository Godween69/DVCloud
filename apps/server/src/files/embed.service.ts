import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { DbService } from '../db/db.service';
import { ActivityService } from './activity.service';
import { FileRow } from './files.service';
import { MediaSettingsService } from './media-settings';
import { MlClient, MlError } from './ml-client';
import { StorageService } from './storage.service';
import { ThumbsService } from './thumbs.service';

// Векторы для поиска по смыслу. Фоновая работа в том же духе, что копии видео: по одному файлу, только когда нет загрузок,
// только когда включено в админке и ML-сервис отвечает. Вектор считается по миниатюре (для видео это кадр-постер):
// модели хватает 224 px, а чтение маленького файла почти ничего не стоит. Один вектор на физический файл.
@Injectable()
export class EmbedService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(ThumbsService) private readonly thumbs: ThumbsService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(MediaSettingsService) private readonly settings: MediaSettingsService,
    @Inject(MlClient) private readonly ml: MlClient,
  ) {}

  onModuleInit(): void {
    if (!this.ml.configured) return; // ML-сервис не подключён: делать нечего
    const ms = Number(process.env.DVCLOUD_EMBED_TICK_MS ?? 30_000);
    this.timer = setInterval(() => void this.tick(), Number.isFinite(ms) && ms >= 100 ? ms : 30_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
  }

  private async save(blobId: string, model: string, vector: Buffer | null, error: string | null): Promise<void> {
    await this.db.query(
      `INSERT INTO embeddings (blob_id, status, model, vector, error) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (blob_id) DO UPDATE SET status = EXCLUDED.status, model = EXCLUDED.model, vector = EXCLUDED.vector, error = EXCLUDED.error, updated_at = now()`,
      [blobId, vector ? 'ready' : 'failed', model, vector, error],
    );
  }

  // Один проход: берёт файлы без вектора текущей модели, пока включено, нет загрузок и сервис отвечает. Сначала новые.
  async tick(): Promise<void> {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      const s = await this.settings.get(true);
      if (!s.searchEnabled) return;
      const h = await this.ml.health();
      if (!h || !h.ready) return;
      for (;;) {
        if (this.stopping || this.activity.busy()) return;
        if (!(await this.settings.get(true)).searchEnabled) return;
        const next = (
          await this.db.query<FileRow>(
            `SELECT f.* FROM blobs b
             JOIN LATERAL (SELECT * FROM files f WHERE f.blob_id = b.id AND f.trashed_at IS NULL ORDER BY f.id LIMIT 1) f ON true
             LEFT JOIN embeddings e ON e.blob_id = b.id
             WHERE (b.mime LIKE 'image/%' OR b.mime LIKE 'video/%') AND (e.blob_id IS NULL OR e.model <> $1)
             ORDER BY b.id DESC LIMIT 1`,
            [h.model],
          )
        ).rows[0];
        if (!next) return;
        if (!(await this.embed(next, h.model))) return;
      }
    } catch {
      /* следующий проход попробует снова */
    } finally {
      this.running = false;
    }
  }

  // false: ML-сервис недоступен, дальше идти бессмысленно (файл остаётся в очереди).
  private async embed(f: FileRow, model: string): Promise<boolean> {
    const blobId = f.blob_id as string;
    const rel = await this.thumbs.ensure(f);
    if (!rel) {
      await this.save(blobId, model, null, 'нет миниатюры');
      return true;
    }
    let data: Buffer;
    try {
      data = await readFile(this.storage.abs(rel));
    } catch {
      await this.save(blobId, model, null, 'миниатюра не читается');
      return true;
    }
    try {
      const r = await this.ml.image(data);
      await this.save(blobId, r.model, r.vector, null);
      return r.model === model; // модель сменилась на ходу: остановиться, следующий проход начнёт с новой
    } catch (e) {
      if (e instanceof MlError && !e.unavailable) {
        await this.save(blobId, model, null, e.message.slice(0, 200));
        return true;
      }
      return false;
    }
  }
}
