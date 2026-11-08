// Эвристика «это скриншот». Чистая функция без диска и базы (проверяется обычным тестом).
// Снимок камеры почти всегда несёт данные EXIF и имеет пропорции 4:3 или 3:2; у скриншота данных камеры нет.

export interface ImageFacts {
  format: string | undefined; // 'png', 'jpeg', 'webp' ...
  hasExif: boolean; // есть ли данные камеры
  width: number; // после поворота
  height: number;
}

// Типичная короткая сторона экранов телефонов (px).
const SCREEN_SHORT = new Set([720, 750, 828, 1080, 1125, 1170, 1179, 1200, 1220, 1242, 1260, 1284, 1290, 1344, 1440, 1600]);

export function looksLikeScreenshot(f: ImageFacts): boolean {
  if (f.hasExif) return false; // у скриншота данных камеры нет
  if (f.width < 300 || f.height < 300) return false;
  if (f.format === 'png') return true; // фото в PNG встречаются редко, скриншоты почти всегда PNG
  const short = Math.min(f.width, f.height);
  const ratio = Math.max(f.width, f.height) / short;
  return SCREEN_SHORT.has(short) && ratio >= 1.7 && ratio <= 2.6; // JPEG с высотой экрана телефона, без EXIF
}
