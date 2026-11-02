import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes } from '../src/lib/format.ts';

test('размеры форматируются по-русски', () => {
  assert.equal(formatBytes(0), '0 Б');
  assert.equal(formatBytes(1536), '1,5 КБ');
  assert.equal(formatBytes(1024 ** 4 * 2), '2,0 ТБ');
});

test('мусор даёт прочерк', () => {
  assert.equal(formatBytes(-1), '—');
  assert.equal(formatBytes(NaN), '—');
});
