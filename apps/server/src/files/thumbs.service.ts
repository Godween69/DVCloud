import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
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

// Сторона квадратной миниатюры в пикселях. Самая крупная плитка: 240 px на ПК и около 185 px на телефоне;
// 560 хватает с запасом для экранов с плотностью 2-3 и весит десятки килобайт.
export const THUMB_SIZE = 560;

// Превью (миниатюры) фото: маленькие WebP, лежат в thumbs/<id файла-оригинала>.webp. Они общие: если один и тот же файл
// лежит у нескольких людей, миниатюра одна. Доступ по-прежнему проверяется по записи человека (см. FilesController),
// а стирается миниатюра только вместе с файлом-оригиналом. Строятся при первом запросе и сразу после загрузки;
// оригиналы не трогаются. Если картинку не разобрать (HEIC, видео, битый файл), миниатюры нет, и сайт показывает значок.
// Старые миниатюры (thumbs/<id человека>/<id записи>.webp) переносятся на новое место один раз при запуске.
@Injectable()
export class ThumbsService implements OnModuleInit {
  private readonly log = new Logger('Thumbs');
  private running = 0;
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

  // Путь внутри данных к готовой миниатюре или null, если сделать её нельзя.
  async ensure(f: FileRow): Promise<string | null> {
    const key = this.key(f);
    if (!ThumbsService.supportsThumb(f.mime) || this.failed.has(key)) return null;
    const rel = this.rel(f);
    try {
      await stat(this.storage.abs(rel));
      return rel;
    } catch {
      /* ещё нет */
    }
    if (f.blob_id && (await this.adopt(this.legacyRel(f), rel))) return rel; // старая миниатюра этой записи становится общей
    let p = this.inflight.get(key);
    if (!p) {
      p = this.build(f, rel).finally(() => this.inflight.delete(key));
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
      p = this.build(f, rel, 'preview', st).finally(() => this.inflight.delete(key));
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
    await this.storage.remove(`previews/${blobId}.webp`);
  }

  // Разовый перенос прежних миниатюр и превью (thumbs/<человек>/<запись>.webp) на общие места.
  // Если общая уже есть (или записи больше нет), прежняя просто удаляется. Отметка в корне каталога данных не даёт повторять работу.
  onModuleInit(): void {
    if (process.env.DVCLOUD_NO_THUMB_MIGRATION === '1') return;
    this.activity.defer(async () => {
      try {
        await this.migrateLegacy();
      } catch (e) {
        this.log.warn(`перенос миниатюр не завершён: ${(e as Error).message}`);
      }
    });
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

  private async slot<T>(run: () => Promise<T>): Promise<T> {
    while (this.running >= 2) await new Promise<void>((r) => this.waiting.push(r)); // не больше двух построений одновременно
    this.running++;
    try {
      return await run();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  private build(f: FileRow, rel: string, kind: 'thumb' | 'preview' = 'thumb', st?: MediaSettings): Promise<string | null> {
    return this.slot(async () => {
      const out = this.storage.abs(rel);
      const tmp = `${out}.${process.pid}.tmp`;
      try {
        await mkdir(dirname(out), { recursive: true });
        const src = f.mime.startsWith('video/') ? await videoFrame(this.storage.abs(f.path)) : this.storage.abs(f.path);
        const img = sharp(src, { failOn: 'error', limitInputPixels: 300_000_000, sequentialRead: typeof src === 'string' }).rotate(); // поворот по метке камеры (EXIF)
        await (kind === 'thumb'
          ? img.resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover', position: 'centre' }).webp({ quality: 70, effort: 2 })
          : img.resize(st!.previewMaxSide, st!.previewMaxSide, { fit: 'inside', withoutEnlargement: true }).webp({ quality: st!.previewQuality, effort: 3 })
        ).toFile(tmp);
        await rename(tmp, out);
        return rel;
      } catch {
        await rm(tmp, { force: true });
        this.failed.add(kind === 'thumb' ? this.key(f) : `p${this.key(f)}`);
        return null;
      }
    });
  }
}
