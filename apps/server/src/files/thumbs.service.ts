import { Inject, Injectable } from '@nestjs/common';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import sharp from 'sharp';
import { FileRow } from './files.service';
import { StorageService } from './storage.service';

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

  constructor(@Inject(StorageService) private readonly storage: StorageService) {
    sharp.cache(false); // кэш libvips не нужен, память на мини-ПК дороже
    sharp.concurrency(1);
  }

  rel(f: Pick<FileRow, 'owner_id' | 'id'>): string {
    return `thumbs/${f.owner_id}/${f.id}.webp`;
  }

  static supports(mime: string): boolean {
    return mime.startsWith('image/');
  }

  // Путь внутри данных к готовой миниатюре или null, если сделать её нельзя.
  async ensure(f: FileRow): Promise<string | null> {
    if (!ThumbsService.supports(f.mime) || this.failed.has(f.id)) return null;
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

  // Построить заранее, не ожидая результата (после загрузки).
  warm(f: FileRow): void {
    void this.ensure(f).catch(() => {});
  }

  async remove(f: Pick<FileRow, 'owner_id' | 'id'>): Promise<void> {
    await this.storage.remove(this.rel(f));
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

  private build(f: FileRow, rel: string): Promise<string | null> {
    return this.slot(async () => {
      const out = this.storage.abs(rel);
      const tmp = `${out}.${process.pid}.tmp`;
      try {
        await mkdir(dirname(out), { recursive: true });
        await sharp(this.storage.abs(f.path), { failOn: 'error', limitInputPixels: 300_000_000, sequentialRead: true })
          .rotate() // поворот по метке камеры (EXIF)
          .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover', position: 'centre' })
          .webp({ quality: 70, effort: 2 })
          .toFile(tmp);
        await rename(tmp, out);
        return rel;
      } catch {
        await rm(tmp, { force: true });
        this.failed.add(f.id);
        return null;
      }
    });
  }
}
