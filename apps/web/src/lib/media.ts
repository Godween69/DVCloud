// Какие файлы принимает сервер: только фото и видео (тот же список, что в apps/server/src/files/names.ts).
const EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'tif', 'tiff', 'bmp', 'mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm', '3gp']);

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 1 ? '' : name.slice(i + 1).toLowerCase();
}

export function isSupported(name: string): boolean {
  return EXT.has(extOf(name));
}

export function isVideo(mime: string): boolean {
  return mime.startsWith('video/');
}
