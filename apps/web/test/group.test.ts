import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FileItem } from '../src/types.ts';
import { compareFeed, groupByMonth, insertSorted } from '../src/lib/group.ts';

const f = (id: string, takenAt: string): FileItem => ({ id, name: `${id}.jpg`, mime: 'image/jpeg', size: 1, sha256: id, takenAt, createdAt: takenAt, trashedAt: null });

test('соседние файлы одного месяца собираются в группы', () => {
  const g = groupByMonth([f('5', '2026-11-10T12:00:00'), f('4', '2026-11-02T12:00:00'), f('3', '2026-09-20T12:00:00'), f('2', '2026-09-01T12:00:00'), f('1', '2025-12-31T12:00:00')]);
  assert.deepEqual(g.map((x) => [x.title, x.items.length]), [['Ноябрь 2026', 2], ['Сентябрь 2026', 2], ['Декабрь 2025', 1]]);
  assert.deepEqual(groupByMonth([]), []);
});

test('порядок ленты: дата по убыванию, при равенстве больший id выше', () => {
  const a = f('9', '2026-05-01T00:00:00Z');
  const b = f('10', '2026-05-01T00:00:00Z');
  const c = f('1', '2026-06-01T00:00:00Z');
  assert.deepEqual([a, b, c].sort(compareFeed).map((x) => x.id), ['1', '10', '9']);
});

test('вставка на своё место и без повторов', () => {
  const base = [f('3', '2026-06-01T00:00:00Z'), f('1', '2026-04-01T00:00:00Z')];
  const r = insertSorted(base, f('2', '2026-05-01T00:00:00Z'));
  assert.deepEqual(r.map((x) => x.id), ['3', '2', '1']);
  assert.equal(insertSorted(r, f('2', '2026-05-01T00:00:00Z')), r);
});
