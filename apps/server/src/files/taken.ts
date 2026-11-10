import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';

const run = promisify(execFile);
const MIN_YEAR = 1990;

// Дата и время съёмки. Порядок доверия: метаданные файла (EXIF у фото, creation_time у видео), затем дата в имени
// файла (2020-05-25 18-55-28.jpg, IMG_20200525_185528.jpg, Screenshot_..., photo_2020-05-25_18-55-28.jpg),
// и только если ничего нет, дата изменения файла из браузера. Время без часового пояса (EXIF и имя) считается
// временем в поясе, заданном в админке.

function tzOffsetMs(utcMs: number, tz: string): number {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(utcMs / 1000) * 1000;
}

// Местное время в заданном поясе -> момент времени (UTC).
export function localToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = guess - tzOffsetMs(guess, tz);
  t = guess - tzOffsetMs(t, tz); // второй проход на границе перехода на летнее время
  return new Date(t);
}

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz.length <= 64;
  } catch {
    return false;
  }
}

function plausible(date: Date, now: number): boolean {
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() >= MIN_YEAR && date.getTime() <= now + 86400000;
}

function realDate(y: number, mo: number, d: number): boolean {
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

const WITH_TIME = /(?<!\d)((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])[-_ T.]?([01]\d|2[0-3])[-_.:]?([0-5]\d)[-_.:]?([0-5]\d)/;
const DATE_ONLY = /(?<!\d)((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?!\d)/;

// Дата из имени файла или null. Только дата без времени: берётся полдень, чтобы смена пояса не сдвинула день.
export function parseFilenameDate(name: string, tz: string, now = Date.now()): Date | null {
  const m = WITH_TIME.exec(name);
  if (m && realDate(Number(m[1]), Number(m[2]), Number(m[3]))) {
    const d = localToUtc(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), tz);
    if (plausible(d, now)) return d;
  }
  const o = DATE_ONLY.exec(name);
  if (o && realDate(Number(o[1]), Number(o[2]), Number(o[3]))) {
    const d = localToUtc(Number(o[1]), Number(o[2]), Number(o[3]), 12, 0, 0, tz);
    if (plausible(d, now)) return d;
  }
  return null;
}

// Достаёт дату съёмки из сырого блока EXIF (как отдаёт sharp): DateTimeOriginal, затем DateTimeDigitized, затем DateTime.
export function parseExifDate(exif: Buffer, tz: string, now = Date.now()): Date | null {
  try {
    let base = 0;
    if (exif.length > 6 && exif.toString('latin1', 0, 4) === 'Exif') base = 6;
    const bo = exif.toString('latin1', base, base + 2);
    const le = bo === 'II';
    if (!le && bo !== 'MM') return null;
    const u16 = (o: number) => (le ? exif.readUInt16LE(base + o) : exif.readUInt16BE(base + o));
    const u32 = (o: number) => (le ? exif.readUInt32LE(base + o) : exif.readUInt32BE(base + o));
    if (u16(2) !== 42) return null;
    const read = (ifd: number, wanted: number[]): Map<number, string> => {
      const out = new Map<number, string>();
      const n = u16(ifd);
      if (n > 500) return out;
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        const tag = u16(e);
        if (!wanted.includes(tag)) continue;
        const type = u16(e + 2);
        const count = u32(e + 4);
        if (tag === 0x8769) {
          out.set(tag, String(u32(e + 8)));
        } else if (type === 2 && count >= 19 && count <= 64) {
          const at = count > 4 ? u32(e + 8) : e + 8;
          out.set(tag, exif.toString('latin1', base + at, base + at + 19));
        }
      }
      return out;
    };
    const ifd0 = read(u32(4), [0x8769, 0x0132]);
    const sub = ifd0.has(0x8769) ? read(Number(ifd0.get(0x8769)), [0x9003, 0x9004]) : new Map<number, string>();
    for (const s of [sub.get(0x9003), sub.get(0x9004), ifd0.get(0x0132)]) {
      const m = s ? /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s) : null;
      if (!m || !realDate(Number(m[1]), Number(m[2]), Number(m[3]))) continue;
      const d = localToUtc(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), tz);
      if (plausible(d, now)) return d;
    }
  } catch {
    /* повреждённый блок EXIF */
  }
  return null;
}

async function videoCreationTime(abs: string): Promise<Date | null> {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format_tags=creation_time', '-of', 'csv=p=0', abs], { timeout: 15_000, maxBuffer: 1 << 16 });
    const t = Date.parse(stdout.trim());
    const d = new Date(t);
    return Number.isFinite(t) && plausible(d, Date.now()) && d.getUTCFullYear() >= 2000 ? d : null;
  } catch {
    return null;
  }
}

export type TakenSource = 'meta' | 'name' | 'none';

// Лучшая известная дата съёмки. source: meta (метаданные), name (имя файла), none (ничего не нашли).
export async function detectTakenAt(o: { abs: string; mime: string; name: string; tz: string }): Promise<{ date: Date | null; source: TakenSource }> {
  let meta: Date | null = null;
  if (o.mime.startsWith('image/')) {
    try {
      const m = await sharp(o.abs, { limitInputPixels: 300_000_000 }).metadata();
      if (m.exif) meta = parseExifDate(m.exif, o.tz);
    } catch {
      /* формат не читается: идём дальше */
    }
  } else if (o.mime.startsWith('video/')) {
    meta = await videoCreationTime(o.abs);
  }
  if (meta) return { date: meta, source: 'meta' };
  const byName = parseFilenameDate(o.name, o.tz);
  if (byName) return { date: byName, source: 'name' };
  return { date: null, source: 'none' };
}

// Текстовые поля EXIF для окна «Инфо»: производитель, модель, программа и три даты в том виде, как записаны в файле.
export function exifFields(exif: Buffer): Record<string, string> {
  const res: Record<string, string> = {};
  try {
    let base = 0;
    if (exif.length > 6 && exif.toString('latin1', 0, 4) === 'Exif') base = 6;
    const bo = exif.toString('latin1', base, base + 2);
    const le = bo === 'II';
    if (!le && bo !== 'MM') return res;
    const u16 = (o: number) => (le ? exif.readUInt16LE(base + o) : exif.readUInt16BE(base + o));
    const u32 = (o: number) => (le ? exif.readUInt32LE(base + o) : exif.readUInt32BE(base + o));
    if (u16(2) !== 42) return res;
    const names: Record<number, string> = { 0x010f: 'Производитель', 0x0110: 'Модель', 0x0131: 'Программа', 0x0132: 'DateTime', 0x9003: 'DateTimeOriginal', 0x9004: 'DateTimeDigitized' };
    const walk = (ifd: number): number | null => {
      const n = u16(ifd);
      if (n > 500) return null;
      let sub: number | null = null;
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        const tag = u16(e);
        const type = u16(e + 2);
        const count = u32(e + 4);
        if (tag === 0x8769) sub = u32(e + 8);
        else if (names[tag] && type === 2 && count >= 2 && count <= 128) {
          const at = count > 4 ? u32(e + 8) : e + 8;
          res[names[tag]] = exif.toString('latin1', base + at, base + at + count - 1).replace(/\0.*$/, '').trim();
        }
      }
      return sub;
    };
    const sub = walk(u32(4));
    if (sub !== null) walk(sub);
  } catch {
    /* повреждённый блок EXIF: покажем то, что успели прочитать */
  }
  return res;
}

// Дата и время создания видео из метаданных файла (как записано) или null.
export async function videoCreationRaw(abs: string): Promise<string | null> {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format_tags=creation_time', '-of', 'csv=p=0', abs], { timeout: 15_000, maxBuffer: 1 << 16 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export interface DateEvidence {
  exif: Record<string, string>; // поля EXIF как записаны в файле (камера, программа, три даты)
  exifDate: string | null; // дата, которую берёт облако из EXIF (ISO, UTC)
  videoCreation: string | null; // creation_time видео как записано
  nameDate: string | null; // дата, найденная в имени файла (ISO, UTC)
  used: TakenSource | 'manual'; // откуда взята дата в ленте
}

// Все следы даты в файле: нужны окну «Инфо» и админу, чтобы понять, почему у снимка именно такая дата.
export async function dateEvidence(o: { abs: string; mime: string; name: string; tz: string; manual?: boolean }): Promise<DateEvidence> {
  const ev: DateEvidence = { exif: {}, exifDate: null, videoCreation: null, nameDate: parseFilenameDate(o.name, o.tz)?.toISOString() ?? null, used: o.manual ? 'manual' : 'none' };
  if (o.mime.startsWith('image/')) {
    try {
      const m = await sharp(o.abs, { limitInputPixels: 300_000_000 }).metadata();
      if (m.exif) {
        ev.exif = exifFields(m.exif);
        ev.exifDate = parseExifDate(m.exif, o.tz)?.toISOString() ?? null;
      }
    } catch {
      /* формат не читается */
    }
  } else if (o.mime.startsWith('video/')) {
    ev.videoCreation = await videoCreationRaw(o.abs);
    const t = ev.videoCreation ? new Date(ev.videoCreation) : null;
    if (t && Number.isFinite(t.getTime()) && plausible(t, Date.now()) && t.getUTCFullYear() >= 2000) ev.exifDate = t.toISOString();
  }
  if (!o.manual) ev.used = ev.exifDate ? 'meta' : ev.nameDate ? 'name' : 'none';
  return ev;
}
