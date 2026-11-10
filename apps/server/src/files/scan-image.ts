import sharp from 'sharp';
import { readableImage } from './heic';

// Сторона картинки, которую видит нейросеть, и по которой потом вырезаются лица для списка людей. Одна и та же,
// чтобы рамки в долях совпадали с вырезкой.
export const SCAN_SIDE = 1600;

// Картинка для нейросети: повёрнута по EXIF, длинная сторона не больше SCAN_SIDE, JPEG.
export async function prepareScan(absPath: string): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(await readableImage(absPath), { failOn: 'error', limitInputPixels: 300_000_000 })
    .rotate()
    .resize(SCAN_SIDE, SCAN_SIDE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer({ resolveWithObject: true });
  return { jpeg: data, width: info.width, height: info.height };
}
