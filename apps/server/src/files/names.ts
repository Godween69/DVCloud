// Чистые функции для имён и дат файлов (без диска и базы), поэтому легко проверяются тестами.

// Допустимые форматы: только фото и видео. SVG и всё, что может содержать скрипты, не входит.
const MEDIA_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  '3gp': 'video/3gpp',
};

export interface CleanName {
  name: string; // безопасное имя файла с расширением в нижнем регистре
  stem: string;
  ext: string;
  mime: string;
}

const MAX_STEM_BYTES = 200; // имя файла в файловой системе не длиннее 255 байт

// Превращает присланное имя в безопасное. Возвращает null, если формат не фото и не видео.
export function cleanFileName(raw: string): CleanName | null {
  let s = raw.normalize('NFC');
  s = s.split(/[\\/]/).pop() ?? '';
  s = s.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[:*?"<>|]/g, '_').trim();
  s = s.replace(/^\.+/, '');
  const dot = s.lastIndexOf('.');
  if (dot < 1) return null;
  const ext = s.slice(dot + 1).toLowerCase();
  if (!Object.hasOwn(MEDIA_TYPES, ext)) return null;
  let stem = s.slice(0, dot).replace(/[ .]+$/, '') || 'file';
  while (Buffer.byteLength(stem) > MAX_STEM_BYTES) stem = Array.from(stem).slice(0, -1).join('');
  return { name: `${stem}.${ext}`, stem, ext, mime: MEDIA_TYPES[ext] };
}

// Имя с номером при совпадении: "IMG (2).jpg".
export function withSuffix(c: { stem: string; ext: string }, n: number): string {
  return n <= 1 ? `${c.stem}.${c.ext}` : `${c.stem} (${n}).${c.ext}`;
}

const MIN_DATE = Date.UTC(1990, 0, 1);

// Дата снимка из заголовка: ISO-строка, миллисекунды (13 цифр) или секунды (10 цифр).
// Всё неправдоподобное (до 1990 года, будущее дальше суток) заменяется текущим временем.
export function parseTakenAt(value: string | undefined, now: number): Date {
  if (value) {
    const v = value.trim();
    const t = /^\d{13}$/.test(v) ? Number(v) : /^\d{10}$/.test(v) ? Number(v) * 1000 : Date.parse(v);
    if (Number.isFinite(t) && t >= MIN_DATE && t <= now + 86400000) return new Date(t);
  }
  return new Date(now);
}

// Папка оригиналов: library/<логин>/<год>/<месяц> (по UTC).
export function libraryDir(login: string, takenAt: Date): string {
  const y = takenAt.getUTCFullYear();
  const m = String(takenAt.getUTCMonth() + 1).padStart(2, '0');
  return `library/${login}/${y}/${m}`;
}

export function trashDir(login: string): string {
  return `trash/${login}`;
}

// Заголовок Content-Disposition с именем в UTF-8 и запасным ASCII-вариантом.
export function contentDisposition(name: string, download: boolean): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}
