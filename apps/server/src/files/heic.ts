import { execFile } from 'node:child_process';
import { mkdtemp, open, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Фото с iPhone и многих Android (HEIC/HEIF) библиотека обработки картинок (sharp) разобрать не может: в ней нет
// декодера HEVC. Поэтому такой снимок сначала превращается в обычный JPEG маленькой программой libheif (heif-dec или
// heif-convert из пакета libheif-tools, ставится в образ сервера, см. Dockerfile). Она запускается отдельным процессом и в код
// проекта не входит. Оригинал на диске не трогается: JPEG живёт секунды, в памяти.

// Главные «марки» файлов HEIC. Файл определяется по содержимому, а не по имени и типу: так работает и для снимков,
// которые облако записало с неточным типом.
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']);
const GENERIC_BRANDS = new Set(['mif1', 'msf1']); // общие марки HEIF; смотрим, нет ли среди совместимых HEIC

// true, если файл по заголовку (ftyp) относится к HEIC/HEIF с кодеком HEVC. AVIF (марка avif) сюда не входит: его читает sharp.
export function brandsAreHeic(head: Buffer): boolean {
  if (head.length < 12 || head.toString('latin1', 4, 8) !== 'ftyp') return false;
  const size = Math.min(head.readUInt32BE(0) || head.length, head.length);
  const major = head.toString('latin1', 8, 12);
  if (HEIC_BRANDS.has(major)) return true;
  if (!GENERIC_BRANDS.has(major)) return false;
  for (let i = 16; i + 4 <= size; i += 4) if (HEIC_BRANDS.has(head.toString('latin1', i, i + 4))) return true;
  return false;
}

export async function isHeicFile(abs: string): Promise<boolean> {
  let fh;
  try {
    fh = await open(abs, 'r');
    const buf = Buffer.alloc(64);
    const { bytesRead } = await fh.read(buf, 0, 64, 0);
    return brandsAreHeic(buf.subarray(0, bytesRead));
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}

// Не больше двух разборов одновременно: каждый берёт десятки мегабайт, а на сервере память ограничена.
let active = 0;
const queue: (() => void)[] = [];
async function slot<T>(job: () => Promise<T>): Promise<T> {
  while (active >= 2) await new Promise<void>((r) => queue.push(r));
  active++;
  try {
    return await job();
  } finally {
    active--;
    queue.shift()?.();
  }
}

let bin: string | null = null; // какая программа нашлась (heif-dec в новых версиях, heif-convert в старых)

// HEIC -> JPEG в памяти. Бросает ошибку, если программы нет или файл не разобрать.
export async function decodeHeic(abs: string): Promise<Buffer> {
  return slot(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'heic-'));
    try {
      const out = join(dir, 'out.jpg');
      const candidates = bin ? [bin] : [process.env.DVCLOUD_HEIF_BIN, 'heif-dec', 'heif-convert'].filter((x): x is string => !!x);
      let lastErr: unknown = new Error('нет программы для HEIC (libheif-tools)');
      for (const cmd of candidates) {
        try {
          await run(cmd, ['-q', '90', abs, out], { timeout: 90_000, maxBuffer: 1024 * 1024 });
          bin = cmd;
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') break; // программа есть, но файл не разобрался: другой пробовать незачем
        }
      }
      if (lastErr) throw lastErr;
      // Если в файле несколько кадров, программа пишет out-1.jpg, out-2.jpg: берём главный (первый).
      const names = (await readdir(dir)).filter((n) => /\.jpe?g$/i.test(n)).sort();
      if (names.length === 0) throw new Error('HEIC не разобран');
      return await readFile(join(dir, names.includes('out.jpg') ? 'out.jpg' : names[0]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

// Что отдать sharp: путь к файлу как есть, а для HEIC готовый JPEG в памяти.
export async function readableImage(abs: string): Promise<string | Buffer> {
  return (await isHeicFile(abs)) ? decodeHeic(abs) : abs;
}
