import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { ActivityService } from './activity.service';
import { BlobRow } from './files.service';
import { MediaSettingsService } from './media-settings';
import { MlClient, MlDetection, MlError, MlHealth } from './ml-client';
import { PeopleService } from './people.service';
import { prepareScan } from './scan-image';
import { StorageService } from './storage.service';

type What = 'faces' | 'pets';

// Фоновый поиск лиц и питомцев на файлах. Устроен как поиск по смыслу (см. EmbedService): по одному файлу, только когда
// нет загрузок, только когда включено в админке и служба ML отвечает с готовой моделью. Один просмотр на физический файл.
// После пачки пересчитываются группы людей у тех, кому эти файлы принадлежат.
@Injectable()
export class PeopleScanService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('PeopleScan');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(MediaSettingsService) private readonly settings: MediaSettingsService,
    @Inject(MlClient) private readonly ml: MlClient,
    @Inject(PeopleService) private readonly people: PeopleService,
  ) {}

  onModuleInit(): void {
    if (!this.ml.configured) return;
    const ms = Number(process.env.DVCLOUD_PEOPLE_TICK_MS ?? 30_000);
    this.timer = setInterval(() => void this.tick(), Number.isFinite(ms) && ms >= 100 ? ms : 30_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
  }

  private model(h: MlHealth, what: What): string | null {
    const m = what === 'faces' ? h.faces : h.pets;
    return m && m.ready ? m.model : null;
  }

  // Один проход: по очереди пачки для лиц и для питомцев, пока есть что просматривать.
  async tick(): Promise<void> {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      const touched = new Set<string>(); // blob_id, у которых что-то нашли
      for (;;) {
        if (this.stopping || this.activity.busy()) break;
        const s = await this.settings.get(true);
        const h = await this.ml.health();
        if (!h) break;
        let did = 0;
        for (const what of ['faces', 'pets'] as const) {
          if (!(what === 'faces' ? s.facesEnabled : s.petsEnabled)) continue;
          const model = this.model(h, what);
          if (!model) continue;
          for (let i = 0; i < 20; i++) {
            if (this.stopping || this.activity.busy()) break;
            const blob = await this.next(what, model);
            if (!blob) break;
            const r = await this.scan(blob, what, model);
            if (r === 'down') return this.finish(touched);
            if (r === 'found') touched.add(blob.id);
            did++;
          }
        }
        if (did === 0) break;
        await this.finish(touched); // группы обновляются по ходу, чтобы человек видел результат до конца всей библиотеки
      }
      await this.finish(touched);
      const s = await this.settings.get(true);
      if ((s.facesEnabled || s.petsEnabled) && !this.activity.busy()) await this.people.refreshPending();
    } catch (e) {
      this.log.warn(`проход прерван: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async finish(touched: Set<string>): Promise<void> {
    if (touched.size === 0) return;
    const ids = [...touched];
    touched.clear();
    await this.people.refreshForBlobs(ids);
  }

  // Следующий файл без просмотра текущей моделью (картинки, которые лежат хотя бы у одного человека вне корзины). Сначала новые.
  private async next(what: What, model: string): Promise<BlobRow | null> {
    const r = await this.db.query<BlobRow>(
      `SELECT b.* FROM blobs b LEFT JOIN detection_scans ds ON ds.blob_id = b.id AND ds.what = $1
       WHERE b.mime LIKE 'image/%' AND (ds.blob_id IS NULL OR ds.model <> $2)
         AND EXISTS (SELECT 1 FROM files f WHERE f.blob_id = b.id AND f.trashed_at IS NULL)
       ORDER BY b.id DESC LIMIT 1`,
      [what, model],
    );
    return r.rows[0] ?? null;
  }

  private async mark(blobId: string, what: What, model: string, status: 'done' | 'failed', error: string | null): Promise<void> {
    await this.db.query(
      `INSERT INTO detection_scans (blob_id, what, model, status, error) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (blob_id, what) DO UPDATE SET model = EXCLUDED.model, status = EXCLUDED.status, error = EXCLUDED.error, scanned_at = now()`,
      [blobId, what, model, status, error],
    );
  }

  // 'down': служба недоступна (файл остаётся в очереди); 'found': что-то найдено; 'none': пусто или файл не читается.
  private async scan(blob: BlobRow, what: What, model: string): Promise<'down' | 'found' | 'none'> {
    let jpeg: Buffer;
    try {
      jpeg = (await prepareScan(this.storage.abs(blob.path))).jpeg;
    } catch {
      await this.mark(blob.id, what, model, 'failed', 'картинка не читается');
      return 'none';
    }
    let found: { model: string; detections: MlDetection[] };
    try {
      found = what === 'faces' ? await this.ml.faces(jpeg) : await this.ml.pets(jpeg);
    } catch (e) {
      if (e instanceof MlError && !e.unavailable) {
        await this.mark(blob.id, what, model, 'failed', e.message.slice(0, 200));
        return 'none';
      }
      return 'down';
    }
    const kinds = what === 'faces' ? ['face'] : ['cat', 'dog'];
    // Прежние находки этого вида (если файл просматривается заново новой моделью) заменяются новыми.
    await this.db.tx(async (c) => {
      await c.query('DELETE FROM detections WHERE blob_id = $1 AND kind = ANY($2::text[])', [blob.id, kinds]);
      for (const d of found.detections) {
        const [x, y, w, h] = d.box;
        await c.query('INSERT INTO detections (blob_id, kind, x, y, w, h, score, model, vector) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [blob.id, d.kind, x, y, w, h, d.score, found.model, d.vector]);
      }
      await c.query(
        `INSERT INTO detection_scans (blob_id, what, model, status, error) VALUES ($1,$2,$3,'done',NULL)
         ON CONFLICT (blob_id, what) DO UPDATE SET model = EXCLUDED.model, status = 'done', error = NULL, scanned_at = now()`,
        [blob.id, what, found.model],
      );
    });
    if (found.model !== model) return 'down'; // модель сменилась на ходу: этот проход заканчиваем, следующий начнёт с новой
    return found.detections.length > 0 ? 'found' : 'none';
  }
}
