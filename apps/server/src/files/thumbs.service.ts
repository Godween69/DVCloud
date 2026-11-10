import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { link, mkdir, readdir, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DbService } from '../db/db.service';
import { FileRow } from './files.service';
import { ActivityService } from './activity.service';
import { StorageService } from './storage.service';
import { MediaSettings, MediaSettingsService } from './media-settings';
import { readableImage } from './heic';

const run = promisify(execFile);

// Кадр видео как PNG в памяти (ffmpeg отдельным процессом). Если ffmpeg нет или видео не читается, бросает ошибку.
async function videoFrame(path: string): Promise<Buffer> {
  for (const at of ['1', '0']) {
    try {
      const { stdout } = await run(
        'ffmpeg',
        ['-v', 'error', '-ss', at, '-i', path, '-frames:v', '1', '-vf', 'scale=1280:-2', '-f', 'image2pipe', '-c:v', 'png', '-'],
        { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
      );
      if (stdout.length > 0) return stdout;
    } catch {
      /* короткое видео: пробуем с нулевой секунды */
    }
  }
  throw new Error('кадр не получен');
}

// У каждого файла-оригинала ровно одна миниатюра (с 0.11.3): снимок целиком, без обрезки, длинная сторона до FIT_SIZE.
// 640 хватает с запасом самой крупной плитке (240 px на ПК, около 185 px на телефоне, экраны с плотностью 2-3).
// Квадратные плитки показывают её через object-cover, «умная плитка» в пропорциях. Лежит в thumbs-fit/<id оригинала>.webp.
export const FIT_SIZE = 640;
// Параметры WebP: компактно, но без грязи на плавных переходах и цветных краях (smartSubsample), усилие 4 даёт заметно меньший файл, чем 2.
const WEBP = { quality: 72, effort: 4, smartSubsample: true } as const;

// Превью (миниатюры) фото: маленькие WebP, лежат в thumbs/<id файла-оригинала>.webp. Они общие: если один и тот же файл
// лежит у нескольких людей, миниатюра одна. Доступ по-прежнему проверяется по записи человека (см. FilesController),
// а стирается миниатюра только вместе с файлом-оригиналом. Строятся при первом запросе и сразу после загрузки;
// оригиналы не трогаются. HEIC перед этим переводится в JPEG (см. heic.ts). Если картинку не разобрать (битый файл), миниатюры нет, и сайт показывает значок.
// Старые миниатюры (thumbs/<id человека>/<id записи>.webp) переносятся на новое место один раз при запуске.
@Injectable()
export class ThumbsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Thumbs');
  private running = 0;
  private urgentRunning = 0; // построения по просьбе человека (открыл фото): идут вне общей очереди
  private fitTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private fitBusy = false;
  private readonly waiting: (() => void)[] = [];
  private readonly inflight = new Map<string, Promise<string | null>>();
  private readonly failed = new Set<string>(); // id, по которым разобрать не вышло: повторно не пробуем до перезапуска

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(MediaSettingsService) private readonly settings: MediaSettingsService,
  ) {
    sharp.cache(false); // кэш libvips не нужен, память на небольшом сервере дороже
    sharp.concurrency(1);
  }

  // Общий путь по файлу-оригиналу. У записи без оригинала (очень старые данные) остаётся путь по записи.
  rel(f: Pick<FileRow, 'owner_id' | 'id' | 'blob_id'>): string {
    return f.blob_id ? `thumbs/${f.blob_id}.webp` : this.legacyRel(f);
  }

  // Миниатюра целиком (в пропорциях снимка) для «Умной плитки».
  fitRel(f: Pick<FileRow, 'owner_id' | 'id' | 'blob_id'>): string {
    return f.blob_id ? `thumbs-fit/${f.blob_id}.webp` : `thumbs-fit/${f.owner_id}-${f.id}.webp`;
  }

  previewRel(f: Pick<FileRow, 'owner_id' | 'id' | 'blob_id'>): string {
    return f.blob_id ? `previews/${f.blob_id}.webp` : this.legacyPreviewRel(f);
  }

  // Прежние пути (по человеку и записи): их читаем только для переноса.
  legacyRel(f: Pick<FileRow, 'owner_id' | 'id'>): string {
    return `thumbs/${f.owner_id}/${f.id}.webp`;
  }

  legacyPreviewRel(f: Pick<FileRow, 'owner_id' | 'id'>): string {
    return `previews/${f.owner_id}/${f.id}.webp`;
  }

  // Ключ для учёта «строится» и «не вышло»: у общих файлов это оригинал, у остальных запись.
  private key(f: Pick<FileRow, 'id' | 'blob_id'>): string {
    return f.blob_id ? `b${f.blob_id}` : f.id;
  }

  // Если общей миниатюры ещё нет, а старая есть, переносим её (без перерасчёта). true: общая теперь на месте.
  private async adopt(from: string, to: string): Promise<boolean> {
    try {
      await link(this.storage.abs(from), this.storage.abs(to)); // link не перезаписывает уже готовую общую
      await unlink(this.storage.abs(from));
      return true;
    } catch {
      return false;
    }
  }

  // Картинки (для отпечатка и превью просмотра).
  static supports(mime: string): boolean {
    return mime.startsWith('image/');
  }

  // Миниатюра есть у картинок и у видео (кадр-постер).
  static supportsThumb(mime: string): boolean {
    return mime.startsWith('image/') || mime.startsWith('video/');
  }

  // Путь внутри данных к готовой миниатюре или null, если сделать её нельзя. Миниатюра одна на файл-оригинал (см. FIT_SIZE).
  async ensure(f: FileRow): Promise<string | null> {
    return this.ensureFit(f);
  }

  // Миниатюра файла: строится при первом запросе (или фоном), потом берётся с диска.
  async ensureFit(f: FileRow): Promise<string | null> {
    const key = `f${this.key(f)}`;
    if (!ThumbsService.supportsThumb(f.mime) || this.failed.has(key)) return null;
    const rel = this.fitRel(f);
    try {
      await stat(this.storage.abs(rel));
      return rel;
    } catch {
      /* ещё нет */
    }
    let p = this.inflight.get(key);
    if (!p) {
      p = this.build(f, rel, 'fit').finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  // Превью для просмотра: строится при первом открытии, потом берётся с диска. null: сделать нельзя, сайт откроет оригинал.
  async ensurePreview(f: FileRow): Promise<string | null> {
    const key = `p${this.key(f)}`;
    if (!ThumbsService.supports(f.mime) || this.failed.has(key)) return null;
    const st = await this.settings.get();
    if (!st.previewEnabled) return null; // выключено в админке: сайт открывает оригинал
    const rel = this.previewRel(f);
    try {
      await stat(this.storage.abs(rel));
      return rel;
    } catch {
      /* ещё нет */
    }
    if (f.blob_id && (await this.adopt(this.legacyPreviewRel(f), rel))) return rel;
    let p = this.inflight.get(key);
    if (!p) {
      p = this.build(f, rel, 'preview', st, true).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  // Построить заранее, не ожидая результата (после загрузки).
  // Миниатюра «про запас» строится, когда загрузки простаивают (см. ActivityService).
  warm(f: FileRow): void {
    this.activity.defer(async () => {
      await this.ensure(f);
    });
  }

  // Запись человека исчезла. Общая миниатюра остаётся: она принадлежит файлу-оригиналу, и ею могут пользоваться другие.
  // Убираем только прежние файлы по записи (если они ещё не были перенесены).
  async remove(f: Pick<FileRow, 'owner_id' | 'id'>): Promise<void> {
    await this.storage.remove(this.legacyRel(f));
    await this.storage.remove(this.legacyPreviewRel(f));
  }

  // Файл-оригинал стёрт: миниатюра и превью уходят вместе с ним.
  async removeBlob(blobId: string): Promise<void> {
    await this.storage.remove(`thumbs/${blobId}.webp`);
    await this.storage.remove(`thumbs-fit/${blobId}.webp`);
    await this.storage.remove(`previews/${blobId}.webp`);
  }

  // Разовый перенос прежних миниатюр и превью (thumbs/<человек>/<запись>.webp) на общие места.
  // Если общая уже есть (или записи больше нет), прежняя просто удаляется. Отметка в корне каталога данных не даёт повторять работу.
  onModuleInit(): void {
    if (process.env.DVCLOUD_NO_FIT_BACKFILL !== '1') {
      // Проверка раз в секунду: если дел нет, это один быстрый запрос в базу; если есть, служба идёт без пауз (см. backfillFit).
      const ms = Number(process.env.DVCLOUD_FIT_BACKFILL_MS ?? 1000);
      this.fitTimer = setInterval(() => void this.backfillFit(), Number.isFinite(ms) && ms >= 100 ? ms : 1000);
      this.fitTimer.unref();
    }
    if (process.env.DVCLOUD_NO_THUMB_MIGRATION === '1') return;
    this.activity.defer(async () => {
      try {
        await this.migrateLegacy();
      } catch (e) {
        this.log.warn(`перенос миниатюр не завершён: ${(e as Error).message}`);
      }
    });
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.fitTimer) clearInterval(this.fitTimer);
  }

  // Фоновая служба миниатюр: строит миниатюру каждому файлу-оригиналу, у которого её ещё нет (thumb_at пусто в базе),
  // от новых к старым. Идёт только когда нет загрузок и без пауз: после порции сразу берёт следующую, пока дела не кончатся.
  // Нужные только: корзина и уже готовые не трогаются, неразбираемые файлы помечаются и повторяются раз в неделю.
  // Прежние квадратные миниатюры (thumbs/<id>.webp) стираются, когда у файла есть новая.
  async backfillFit(limit = 8): Promise<number> {
    if (this.fitBusy || this.activity.busy()) return 0;
    this.fitBusy = true;
    let made = 0;
    let more = false;
    try {
      const r = await this.db.query<FileRow>(
        `SELECT f.* FROM blobs b
         JOIN LATERAL (SELECT * FROM files WHERE blob_id = b.id AND trashed_at IS NULL ORDER BY id LIMIT 1) f ON true
         WHERE b.thumb_at IS NULL AND (b.thumb_failed_at IS NULL OR b.thumb_failed_at < now() - interval '7 days')
           AND (b.mime LIKE 'image/%' OR b.mime LIKE 'video/%')
         ORDER BY b.id DESC LIMIT $1`,
        [limit],
      );
      for (const f of r.rows) {
        if (this.activity.busy()) break; // началась загрузка: уступаем
        const exists = await stat(this.storage.abs(this.fitRel(f))).then(() => true, () => false);
        if (exists) {
          await this.markBuilt(f);
        } else if ((await this.ensureFit(f)) !== null) {
          made++;
        } else {
          await this.markFailed(f); // в памяти уже помечено, теперь и в базе
        }
        await new Promise((res) => setImmediate(res));
      }
      more = r.rows.length === limit;
      if (made > 0) this.log.log(`миниатюры в фоне: построено ${made}`);
    } catch (e) {
      this.log.warn(`подготовка миниатюр не удалась: ${(e as Error).message}`);
      more = false;
    } finally {
      this.fitBusy = false;
    }
    if (more && !this.stopped) {
      const t = setTimeout(() => void this.backfillFit(limit), 20);
      t.unref();
    }
    return made;
  }

  // Миниатюра построена: запомнить в базе и убрать прежнюю квадратную.
  private async markBuilt(f: Pick<FileRow, 'blob_id'>): Promise<void> {
    if (!f.blob_id) return;
    await this.db.query('UPDATE blobs SET thumb_at = now(), thumb_failed_at = NULL WHERE id = $1', [f.blob_id]);
    await this.storage.remove(`thumbs/${f.blob_id}.webp`);
  }

  private async markFailed(f: Pick<FileRow, 'blob_id'>): Promise<void> {
    if (!f.blob_id) return;
    await this.db.query('UPDATE blobs SET thumb_failed_at = now() WHERE id = $1 AND thumb_at IS NULL', [f.blob_id]);
  }

  async migrateLegacy(): Promise<{ moved: number; dropped: number }> {
    const mark = this.storage.abs('.thumbs-shared-v1');
    try {
      await stat(mark);
      return { moved: 0, dropped: 0 };
    } catch {
      /* ещё не переносили */
    }
    let moved = 0, dropped = 0;
    for (const kind of ['thumbs', 'previews'] as const) {
      let owners;
      try {
        owners = await readdir(this.storage.abs(kind), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const o of owners) {
        if (!o.isDirectory()) continue;
        const dir = this.storage.abs(`${kind}/${o.name}`);
        for (const name of await readdir(dir)) {
          const m = /^(\d+)\.webp$/.exec(name);
          if (!m) continue;
          const row = (await this.db.query<{ blob_id: string | null }>('SELECT blob_id FROM files WHERE id = $1 AND owner_id = $2', [m[1], o.name])).rows[0];
          const to = row?.blob_id ? `${kind}/${row.blob_id}.webp` : null;
          if (to && (await this.adopt(`${kind}/${o.name}/${name}`, to))) {
            moved++;
          } else if (to) {
            await rm(join(dir, name), { force: true }); // общая уже есть: копия не нужна
            dropped++;
          } else if (row) {
            continue; // запись без оригинала: остаётся на прежнем месте
          } else {
            await rm(join(dir, name), { force: true }); // записи больше нет
            dropped++;
          }
          await new Promise((r) => setImmediate(r)); // не занимать процессор надолго подряд
        }
        await rmdir(dir).catch(() => undefined); // пустую папку человека убираем, непустую оставляем
      }
    }
    await writeFile(mark, new Date().toISOString());
    if (moved + dropped > 0) this.log.log(`миниатюры и превью стали общими: перенесено ${moved}, лишних копий удалено ${dropped}`);
    return { moved, dropped };
  }

  // Построение идёт в общей очереди (не больше двух сразу). Срочное (человек открыл фото) очередь не ждёт: иначе оно вставало бы
  // позади сотен миниатюр для плиток, которые сайт просит одновременно.
  private async slot<T>(run: () => Promise<T>, urgent = false): Promise<T> {
    if (urgent && this.urgentRunning < 3) {
      this.urgentRunning++;
      try {
        return await run();
      } finally {
        this.urgentRunning--;
      }
    }
    while (this.running >= 2) await new Promise<void>((r) => this.waiting.push(r)); // не больше двух построений одновременно
    this.running++;
    try {
      return await run();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  private build(f: FileRow, rel: string, kind: 'preview' | 'fit' = 'fit', st?: MediaSettings, urgent = false): Promise<string | null> {
    return this.slot(async () => {
      const out = this.storage.abs(rel);
      const tmp = `${out}.${process.pid}.tmp`;
      try {
        await mkdir(dirname(out), { recursive: true });
        const src = f.mime.startsWith('video/') ? await videoFrame(this.storage.abs(f.path)) : await readableImage(this.storage.abs(f.path)); // HEIC сначала превращается в JPEG
        const img = sharp(src, { failOn: 'error', limitInputPixels: 300_000_000, sequentialRead: typeof src === 'string' }).rotate(); // поворот по метке камеры (EXIF)
        await (kind === 'fit'
          ? img.resize(FIT_SIZE, FIT_SIZE, { fit: 'inside', withoutEnlargement: true }).webp(WEBP)
          : img.resize(st!.previewMaxSide, st!.previewMaxSide, { fit: 'inside', withoutEnlargement: true }).webp({ quality: st!.previewQuality, effort: 3 })
        ).toFile(tmp);
        await rename(tmp, out);
        if (kind === 'fit') await this.markBuilt(f).catch(() => undefined);
        return rel;
      } catch {
        await rm(tmp, { force: true });
        this.failed.add(kind === 'fit' ? `f${this.key(f)}` : `p${this.key(f)}`);
        if (kind === 'fit') await this.markFailed(f).catch(() => undefined);
        return null;
      }
    }, urgent);
  }
}
