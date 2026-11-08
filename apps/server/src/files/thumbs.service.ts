import { Inject, Injectable } from '@nestjs/common';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

// Превью (миниатюры) фото: маленькие WebP, лежат в thumbs/<id человека>/<id файла>.webp.
// Строятся при первом запросе и сразу после загрузки; оригиналы не трогаются. Если картинку не разобрать
// (HEIC, видео, битый файл), миниатюры нет, и сайт показывает значок.
@Injectable()
export class ThumbsService {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly inflight = new Map<string, Promise<string | null>>();
  private readonly failed = new Set<string>(); // id, по которым разобрать не вышло: повторно не пробуем до перезапуска

  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(MediaSettingsService) private readonly settings: MediaSettingsService,
  ) {
    sharp.cache(false); // кэш libvips не нужен, память на мини-ПК дороже
    sharp.concurrency(1);
  }

  rel(f: Pick<FileRow, 'owner_id' | 'id'>): string {
    return `thumbs/${f.owner_id}/${f.id}.webp`;
  }

  previewRel(f: Pick<FileRow, 'owner_id' | 'id'>): string {
    return `previews/${f.owner_id}/${f.id}.webp`;
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
    if (!ThumbsService.supportsThumb(f.mime) || this.failed.has(f.id)) return null;
    const rel = this.rel(f);
    try {
      await stat(this.storage.abs(rel));
      return rel;
    } catch {
      /* ещё нет, строим */
    }
    let p = this.inflight.get(f.id);
    if (!p) {
      p = this.build(f, rel).finally(() => this.inflight.delete(f.id));
      this.inflight.set(f.id, p);
    }
    return p;
  }

  // Превью для просмотра: строится при первом открытии, потом берётся с диска. null: сделать нельзя, сайт откроет оригинал.
  async ensurePreview(f: FileRow): Promise<string | null> {
    const key = `p${f.id}`;
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

  async remove(f: Pick<FileRow, 'owner_id' | 'id'>): Promise<void> {
    await this.storage.remove(this.rel(f));
    await this.storage.remove(this.previewRel(f));
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
        this.failed.add(kind === 'thumb' ? f.id : `p${f.id}`);
        return null;
      }
    });
  }
}
