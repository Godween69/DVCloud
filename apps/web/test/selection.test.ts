import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rangeIds } from '../src/lib/selection.ts';
import { dayHeading, groupByDay } from '../src/lib/format.ts';
import { readDate, showDate, parseIso } from '../src/lib/dates.ts';

test('rangeIds: диапазон в любую сторону и крайние случаи', () => {
  const o = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(rangeIds(o, 'b', 'd'), ['b', 'c', 'd']);
  assert.deepEqual(rangeIds(o, 'd', 'b'), ['b', 'c', 'd']);
  assert.deepEqual(rangeIds(o, 'x', 'c'), ['c']);
  assert.deepEqual(rangeIds(o, 'a', 'x'), []);
});

test('даты в корзине: сегодня, вчера и группировка по дням', () => {
  const now = new Date(2026, 5, 12, 15, 0, 0);
  assert.equal(dayHeading(new Date(2026, 5, 12, 9).toISOString(), now), 'Сегодня');
  assert.equal(dayHeading(new Date(2026, 5, 11, 23).toISOString(), now), 'Вчера');
  const g = groupByDay([
    { trashedAt: new Date(2026, 5, 12, 10).toISOString() }, { trashedAt: new Date(2026, 5, 12, 8).toISOString() }, { trashedAt: new Date(2026, 5, 3, 8).toISOString() },
  ], now);
  assert.deepEqual(g.map((x) => x.items.length), [2, 1]);
  assert.equal(g[0].title, 'Сегодня');
});

test('ввод даты вручную', () => {
  assert.equal(readDate('1.10.2018', true), '2018-10-01');
  assert.equal(readDate('01.10.18', true), '2018-10-01');
  assert.equal(readDate('01.10.18', false), null);
  assert.equal(readDate('2018-10-01', true), '2018-10-01');
  assert.equal(readDate('31.02.2020', true), null);
  assert.equal(readDate('мусор', true), null);
  assert.equal(showDate('2018-10-01'), '01.10.2018');
  assert.equal(parseIso('2018-10-01')?.getMonth(), 9);
});
