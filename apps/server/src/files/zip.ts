// Потоковый ZIP без зависимостей: способ "store" (фото и видео и так сжаты), поэтому размер архива известен заранее
// и браузер показывает честный прогресс. Имена в UTF-8. Большие файлы и архивы описываются через zip64.
import { createReadStream } from 'node:fs';
import { crc32 } from 'node:zlib';

export interface ZipEntry {
  name: string; // уже безопасное и уникальное имя внутри архива
  size: number;
  mtime: Date;
  open: () => AsyncIterable<Buffer>;
}

const U32 = 0xffffffff;
const U16 = 0xffff;

function dos(d: Date): { time: number; date: number } {
  const y = Math.min(Math.max(d.getUTCFullYear(), 1980), 2107);
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

const FLAGS = 0x0808; // бит 3: CRC в хвосте записи; бит 11: имена в UTF-8

function localHeader(e: ZipEntry, big: boolean): Buffer {
  const name = Buffer.from(e.name);
  const extra = big ? Buffer.alloc(20) : Buffer.alloc(0);
  if (big) {
    extra.writeUInt16LE(1, 0);
    extra.writeUInt16LE(16, 2);
    extra.writeBigUInt64LE(BigInt(e.size), 4);
    extra.writeBigUInt64LE(BigInt(e.size), 12);
  }
  const h = Buffer.alloc(30);
  const t = dos(e.mtime);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(big ? 45 : 20, 4);
  h.writeUInt16LE(FLAGS, 6);
  h.writeUInt16LE(0, 8);
  h.writeUInt16LE(t.time, 10);
  h.writeUInt16LE(t.date, 12);
  h.writeUInt32LE(0, 14); // CRC придёт в хвосте
  h.writeUInt32LE(big ? U32 : e.size, 18);
  h.writeUInt32LE(big ? U32 : e.size, 22);
  h.writeUInt16LE(name.length, 26);
  h.writeUInt16LE(extra.length, 28);
  return Buffer.concat([h, name, extra]);
}

function descriptor(crc: number, size: number, big: boolean): Buffer {
  const d = Buffer.alloc(big ? 24 : 16);
  d.writeUInt32LE(0x08074b50, 0);
  d.writeUInt32LE(crc, 4);
  if (big) {
    d.writeBigUInt64LE(BigInt(size), 8);
    d.writeBigUInt64LE(BigInt(size), 16);
  } else {
    d.writeUInt32LE(size, 8);
    d.writeUInt32LE(size, 12);
  }
  return d;
}

function centralHeader(e: ZipEntry, crc: number, offset: number): Buffer {
  const name = Buffer.from(e.name);
  const bigSize = e.size >= U32;
  const bigOff = offset >= U32;
  const fields: bigint[] = [];
  if (bigSize) fields.push(BigInt(e.size), BigInt(e.size));
  if (bigOff) fields.push(BigInt(offset));
  const extra = Buffer.alloc(fields.length ? 4 + fields.length * 8 : 0);
  if (fields.length) {
    extra.writeUInt16LE(1, 0);
    extra.writeUInt16LE(fields.length * 8, 2);
    fields.forEach((v, i) => extra.writeBigUInt64LE(v, 4 + i * 8));
  }
  const h = Buffer.alloc(46);
  const t = dos(e.mtime);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(45, 4);
  h.writeUInt16LE(bigSize ? 45 : 20, 6);
  h.writeUInt16LE(FLAGS, 8);
  h.writeUInt16LE(0, 10);
  h.writeUInt16LE(t.time, 12);
  h.writeUInt16LE(t.date, 14);
  h.writeUInt32LE(crc, 16);
  h.writeUInt32LE(bigSize ? U32 : e.size, 20);
  h.writeUInt32LE(bigSize ? U32 : e.size, 24);
  h.writeUInt16LE(name.length, 28);
  h.writeUInt16LE(extra.length, 30);
  h.writeUInt32LE(bigOff ? U32 : offset, 42);
  return Buffer.concat([h, name, extra]);
}

function endRecords(count: number, cdOffset: number, cdSize: number): Buffer {
  const need64 = count >= U16 || cdOffset >= U32 || cdSize >= U32;
  const parts: Buffer[] = [];
  if (need64) {
    const z = Buffer.alloc(56);
    z.writeUInt32LE(0x06064b50, 0);
    z.writeBigUInt64LE(44n, 4);
    z.writeUInt16LE(45, 12);
    z.writeUInt16LE(45, 14);
    z.writeBigUInt64LE(BigInt(count), 24);
    z.writeBigUInt64LE(BigInt(count), 32);
    z.writeBigUInt64LE(BigInt(cdSize), 40);
    z.writeBigUInt64LE(BigInt(cdOffset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(cdOffset + cdSize), 8);
    loc.writeUInt32LE(1, 16);
    parts.push(z, loc);
  }
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(need64 ? U16 : count, 8);
  e.writeUInt16LE(need64 ? U16 : count, 10);
  e.writeUInt32LE(need64 ? U32 : cdSize, 12);
  e.writeUInt32LE(need64 ? U32 : cdOffset, 16);
  parts.push(e);
  return Buffer.concat(parts);
}

// Точный размер будущего архива (нужен для Content-Length).
export function zipSize(entries: ZipEntry[]): number {
  let off = 0;
  let cd = 0;
  for (const e of entries) {
    const big = e.size >= U32;
    off += localHeader(e, big).length + e.size + (big ? 24 : 16);
  }
  const cdBuf: number[] = [];
  let o = 0;
  for (const e of entries) {
    const big = e.size >= U32;
    cdBuf.push(centralHeader(e, 0, o).length);
    o += localHeader(e, big).length + e.size + (big ? 24 : 16);
  }
  cd = cdBuf.reduce((a, b) => a + b, 0);
  return off + cd + endRecords(entries.length, off, cd).length;
}

export async function* zipStream(entries: ZipEntry[]): AsyncGenerator<Buffer> {
  let offset = 0;
  const done: { e: ZipEntry; crc: number; offset: number }[] = [];
  for (const e of entries) {
    const big = e.size >= U32;
    const head = localHeader(e, big);
    const start = offset;
    yield head;
    offset += head.length;
    let crc = 0;
    let sent = 0;
    for await (const chunk of e.open()) {
      sent += chunk.length;
      if (sent > e.size) throw new Error(`Файл ${e.name} вырос во время упаковки`);
      crc = crc32(chunk, crc);
      yield chunk;
    }
    if (sent !== e.size) throw new Error(`Файл ${e.name} изменился во время упаковки`);
    offset += sent;
    const d = descriptor(crc, e.size, big);
    yield d;
    offset += d.length;
    done.push({ e, crc, offset: start });
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const x of done) {
    const h = centralHeader(x.e, x.crc, x.offset);
    cdSize += h.length;
    yield h;
  }
  yield endRecords(done.length, cdStart, cdSize);
}

export function openFile(abs: string): () => AsyncIterable<Buffer> {
  return () => createReadStream(abs, { highWaterMark: 256 * 1024 }) as AsyncIterable<Buffer>;
}
