import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localToUtc, parseExifDate, parseFilenameDate, validTimezone } from '../src/files/taken';

const NOW = Date.parse('2026-11-08T12:00:00Z');

test('время в поясе переводится в UTC (зима и лето)', () => {
  assert.equal(localToUtc(2020, 5, 25, 18, 55, 28, 'Europe/Moscow').toISOString(), '2020-05-25T15:55:28.000Z');
  assert.equal(localToUtc(2020, 5, 25, 18, 55, 28, 'UTC').toISOString(), '2020-05-25T18:55:28.000Z');
  assert.equal(localToUtc(2021, 1, 10, 9, 0, 0, 'America/New_York').toISOString(), '2021-01-10T14:00:00.000Z');
  assert.equal(validTimezone('Europe/Moscow'), true);
  assert.equal(validTimezone('Нигде/Никогда'), false);
});

test('дата из имени файла: разные привычные шаблоны', () => {
  const t = (n: string) => parseFilenameDate(n, 'UTC', NOW)?.toISOString() ?? null;
  assert.equal(t('2020-05-25 18-55-28.jpg'), '2020-05-25T18:55:28.000Z');
  assert.equal(t('IMG_20200525_185528.jpg'), '2020-05-25T18:55:28.000Z');
  assert.equal(t('PXL_20200525_185528123.jpg'), '2020-05-25T18:55:28.000Z');
  assert.equal(t('Screenshot_20200525-185528.png'), '2020-05-25T18:55:28.000Z');
  assert.equal(t('photo_2020-05-25_18-55-28.jpg'), '2020-05-25T18:55:28.000Z');
  assert.equal(t('VID_20200525_185528.mp4'), '2020-05-25T18:55:28.000Z');
  assert.equal(t('IMG-20200525-WA0001.jpg'), '2020-05-25T12:00:00.000Z', 'только дата: полдень');
});

test('дата из имени файла: мусор и невозможные даты отбрасываются', () => {
  const t = (n: string) => parseFilenameDate(n, 'UTC', NOW);
  assert.equal(t('IMG_1234.jpg'), null);
  assert.equal(t('1590432928123.jpg'), null, 'unix-время не дата');
  assert.equal(t('2020-13-45 10-00-00.jpg'), null);
  assert.equal(t('2021-02-30.jpg'), null, 'такого дня нет');
  assert.equal(t('2099-01-01.jpg'), null, 'будущее');
  assert.equal(t('1980-01-01.jpg'), null, 'до 1990');
  assert.equal(t('число 12345678901234567890.jpg'), null);
});

// Минимальный блок EXIF (порядок байт II): IFD0 с DateTime и указателем на Exif-IFD с DateTimeOriginal.
function exifWith(original: string | null, plain: string | null): Buffer {
  const ascii = (s: string) => Buffer.concat([Buffer.from(s, 'latin1'), Buffer.from([0])]);
  const o = original ? ascii(original) : null;
  const p = plain ? ascii(plain) : null;
  // раскладка: заголовок 8 байт, IFD0 (2 записи), Exif-IFD (1 запись), затем строки
  const ifd0 = 8;
  const ifd0Size = 2 + 2 * 12 + 4;
  const ex = ifd0 + ifd0Size;
  const exSize = 2 + 1 * 12 + 4;
  const strP = ex + exSize;
  const strO = strP + (p ? 20 : 0);
  const b = Buffer.alloc(strO + (o ? 20 : 0));
  b.write('II', 0, 'latin1'); b.writeUInt16LE(42, 2); b.writeUInt32LE(ifd0, 4);
  b.writeUInt16LE(2, ifd0);
  const e0 = (i: number, tag: number, type: number, count: number, val: number) => { const a = ifd0 + 2 + i * 12; b.writeUInt16LE(tag, a); b.writeUInt16LE(type, a + 2); b.writeUInt32LE(count, a + 4); b.writeUInt32LE(val, a + 8); };
  e0(0, 0x0132, 2, p ? 20 : 0, strP);
  e0(1, 0x8769, 4, 1, ex);
  b.writeUInt16LE(1, ex);
  { const a = ex + 2; b.writeUInt16LE(0x9003, a); b.writeUInt16LE(2, a + 2); b.writeUInt32LE(o ? 20 : 0, a + 4); b.writeUInt32LE(strO, a + 8); }
  if (p) p.copy(b, strP);
  if (o) o.copy(b, strO);
  return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), b]);
}

test('EXIF: DateTimeOriginal главнее DateTime; пояс применяется к времени без пояса', () => {
  const buf = exifWith('2020:05:25 18:55:28', '2025:07:01 12:45:00');
  assert.equal(parseExifDate(buf, 'UTC', NOW)?.toISOString(), '2020-05-25T18:55:28.000Z');
  assert.equal(parseExifDate(buf, 'Europe/Moscow', NOW)?.toISOString(), '2020-05-25T15:55:28.000Z');
  assert.equal(parseExifDate(exifWith(null, '2019:01:02 03:04:05'), 'UTC', NOW)?.toISOString(), '2019-01-02T03:04:05.000Z');
});

test('EXIF: нули, будущее, мусор и обрезанный блок дают null и ничего не роняют', () => {
  assert.equal(parseExifDate(exifWith('0000:00:00 00:00:00', null), 'UTC', NOW), null);
  assert.equal(parseExifDate(exifWith('2099:01:01 00:00:00', null), 'UTC', NOW), null);
  assert.equal(parseExifDate(Buffer.from('мусор'), 'UTC', NOW), null);
  assert.equal(parseExifDate(exifWith('2020:05:25 18:55:28', null).subarray(0, 20), 'UTC', NOW), null);
});
