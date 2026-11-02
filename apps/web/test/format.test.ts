import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countFiles, formatBytes, formatDateTime, monthTitle, plural } from '../src/lib/format.ts';

test('размеры форматируются по-русски', () => {
  assert.equal(formatBytes(0), '0 Б');
  assert.equal(formatBytes(1536), '1,5 КБ');
  assert.equal(formatBytes(1024 ** 4 * 2), '2,0 ТБ');
});

test('мусор даёт прочерк', () => {
  assert.equal(formatBytes(-1), '—');
  assert.equal(formatBytes(NaN), '—');
});

test('склонение числительных', () => {
  assert.equal(countFiles(1), '1 файл');
  assert.equal(countFiles(2), '2 файла');
  assert.equal(countFiles(5), '5 файлов');
  assert.equal(countFiles(11), '11 файлов');
  assert.equal(countFiles(21), '21 файл');
  assert.equal(countFiles(112), '112 файлов');
  assert.equal(plural(0, 'а', 'б', 'в'), 'в');
});

test('месяц и дата', () => {
  assert.equal(monthTitle(2026, 10), 'Ноябрь 2026');
  assert.match(formatDateTime('2026-05-12T12:30:00'), /^12 мая 2026, 12:30$/);
  assert.equal(formatDateTime('мусор'), '—');
});
