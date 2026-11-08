import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import sharp from 'sharp';
import { DbService } from '../db/db.service';
import { Fingerprint, SIZE, fingerprintFromRgb } from './similar';
import { FileRow } from './files.service';
import { ActivityService } from './activity.service';
import { StorageService } from './storage.service';
import { ThumbsService } from './thumbs.service';
import { looksLikeScreenshot } from './screenshot';

// Отпечатки фото для поиска похожих. Считаются в фоне: сразу после загрузки и пачками для старых файлов.
// Оригинал открывается один раз, уменьшается до 256 px и дальше всё считается по маленькой копии.
@Injectable()
export class FingerprintService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Fingerprints');
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private readonly failed = new Set<string>(); // id, по которым разобрать не вышло: повторно не пробуем до перезапуска

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(ActivityService) private readonly activity: ActivityService,
  ) {}

  // Каждые 20 секунд берём небольшую пачку файлов без отпечатка (старые файлы и то, что не успели при загрузке).
  onModuleInit(): void {
    const ms = Number(process.env.DVCLOUD_FP_TICK_MS ?? 20_000);
    this.timer = setInterval(() => void this.backfill(), Number.isFinite(ms) && ms >= 100 ? ms : 20_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async compute(path: string): Promise<Fingerprint> {
    const base = () => sharp(path, { failOn: 'error', limitInputPixels: 300_000_000, sequentialRead: true }).rotate(); // поворот по EXIF
    const { data, info } = await base().resize(SIZE, SIZE, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    // Исходные размеры после поворота: после .rotate() они в метаданных результата не видны, поэтому считаем отдельно.
    const m = await sharp(path, { limitInputPixels: 300_000_000 }).metadata();
    const swap = (m.orientation ?? 1) >= 5;
    const ow = (swap ? m.height : m.width) ?? info.width;
    const oh = (swap ? m.width : m.height) ?? info.height;
    return fingerprintFromRgb(data, info.width, info.height, ow, oh);
  }

  // Посчитать и сохранить для одного файла. Ошибки не пробрасываются: файл просто остаётся без отпечатка.
  async ensure(f: FileRow): Promise<void> {
    if (!ThumbsService.supports(f.mime) || this.failed.has(f.id)) return;
    try {
      const abs = this.storage.abs(f.path);
      const fp = await this.compute(abs);
      const meta = await sharp(abs, { limitInputPixels: 300_000_000 }).metadata();
      const shot = looksLikeScreenshot({ format: meta.format, hasExif: !!meta.exif, width: fp.width, height: fp.height });
      await this.db.query(
        `INSERT INTO file_fingerprints (file_id, dhash, tiny, width, height, sharpness, screenshot, shot_checked) VALUES ($1,$2,$3,$4,$5,$6,$7,true)
         ON CONFLICT (file_id) DO NOTHING`,
        [f.id, fp.dhash, fp.tiny, fp.width, fp.height, fp.sharpness, shot],
      );
    } catch {
      this.failed.add(f.id);
    }
  }

  warm(f: FileRow): void {
    this.activity.defer(() => this.ensure(f));
  }

  // Отметка «скриншот» для отпечатков, посчитанных раньше: читается только заголовок файла, быстро.
  async checkScreenshots(limit = 300): Promise<number> {
    const r = await this.db.query<{ file_id: string; path: string; width: number; height: number }>(
      `SELECT p.file_id, f.path, p.width, p.height FROM file_fingerprints p JOIN files f ON f.id = p.file_id WHERE NOT p.shot_checked ORDER BY p.file_id DESC LIMIT $1`,
      [limit],
    );
    for (const x of r.rows) {
      let shot = false;
      try {
        const meta = await sharp(this.storage.abs(x.path), { limitInputPixels: 300_000_000 }).metadata();
        shot = looksLikeScreenshot({ format: meta.format, hasExif: !!meta.exif, width: x.width, height: x.height });
      } catch {
        /* файл не читается: считаем обычным, чтобы не проверять его снова и снова */
      }
      await this.db.query('UPDATE file_fingerprints SET screenshot = $2, shot_checked = true WHERE file_id = $1', [x.file_id, shot]);
    }
    return r.rows.length;
  }

  // Пачка файлов без отпечатка. Один за другим, чтобы не нагружать мини-ПК.
  async backfill(limit = 40): Promise<number> {
    if (this.busy || this.activity.busy()) return 0; // во время загрузок отпечатки ждут
    this.busy = true;
    try {
      await this.checkScreenshots();
      const skip = [...this.failed];
      const r = await this.db.query<FileRow>(
        `SELECT f.* FROM files f LEFT JOIN file_fingerprints p ON p.file_id = f.id
         WHERE p.file_id IS NULL AND f.trashed_at IS NULL AND f.mime LIKE 'image/%' AND NOT (f.id::text = ANY($2::text[]))
         ORDER BY f.id DESC LIMIT $1`,
        [limit, skip],
      );
      for (const f of r.rows) await this.ensure(f);
      if (r.rows.length) this.log.log(`отпечатки: обработано ${r.rows.length}`);
      return r.rows.length;
    } finally {
      this.busy = false;
    }
  }

  // Сколько фото уже обработано, чтобы в интерфейсе было видно «идёт подготовка».
  async progress(ownerId: string): Promise<{ images: number; ready: number }> {
    const r = await this.db.query<{ images: string; ready: string }>(
      `SELECT COUNT(*) AS images, COUNT(p.file_id) AS ready FROM files f LEFT JOIN file_fingerprints p ON p.file_id = f.id
       WHERE f.owner_id = $1 AND f.trashed_at IS NULL AND f.mime LIKE 'image/%'`,
      [ownerId],
    );
    return { images: Number(r.rows[0].images), ready: Number(r.rows[0].ready) };
  }
}
