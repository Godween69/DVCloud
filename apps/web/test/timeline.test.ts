import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bubbleTitle, centerOf, currentKey, indexAt, indexOfKey, keyIndex, monthKey, thinMarks, yearMarks, type Month } from '../src/lib/timeline.ts';

const months: Month[] = [{ y: 2026, m: 5, n: 10 }, { y: 2026, m: 3, n: 4 }, { y: 2025, m: 12, n: 1 }, { y: 2015, m: 3, n: 7 }];

test('палец на полосе -> номер месяца: края и середина', () => {
  assert.equal(indexAt(0, 4), 0);
  assert.equal(indexAt(0.49, 4), 1);
  assert.equal(indexAt(0.99, 4), 3);
  assert.equal(indexAt(1, 4), 3);
  assert.equal(indexAt(-5, 4), 0);
  assert.equal(indexAt(9, 4), 3);
  assert.equal(indexAt(NaN, 4), 0);
  assert.equal(indexAt(0.5, 0), -1);
});

test('центр клетки месяца лежит внутри своей клетки и обратно даёт тот же номер', () => {
  for (const count of [1, 2, 7, 120]) for (let i = 0; i < count; i++) assert.equal(indexAt(centerOf(i, count), count), i);
  assert.equal(centerOf(0, 0), 0);
});

test('поиск месяца по ключу: точный, пропущенный (ближайший более ранний), слишком ранний', () => {
  assert.equal(indexOfKey(months, '2026-03'), 1);
  assert.equal(indexOfKey(months, '2026-04'), 1);
  assert.equal(indexOfKey(months, '2030-01'), 0);
  assert.equal(indexOfKey(months, '2000-01'), 3);
  assert.equal(indexOfKey([], '2026-01'), -1);
  assert.equal(monthKey(2015, 3), '2015-03');
});

test('подписи годов на первом месяце года, лишние подписи прореживаются', () => {
  assert.deepEqual(yearMarks(months), [{ y: 2026, index: 0 }, { y: 2025, index: 2 }, { y: 2015, index: 3 }]);
  const many = Array.from({ length: 24 }, (_, i) => ({ y: 2026 - i, m: 1, n: 1 }));
  const thin = thinMarks(yearMarks(many), many.length, 0.1);
  assert.ok(thin.length < 24 && thin.length >= 8);
  assert.equal(thin[0].y, 2026);
  assert.equal(thinMarks(yearMarks(months), 4, 0.1).length, 3);
});

test('подпись над пальцем по-русски', () => {
  assert.equal(bubbleTitle({ y: 2015, m: 3, n: 1 }), 'март 2015');
});

test('клавиши: стрелки, страницы, Home и End не выходят за края', () => {
  assert.equal(keyIndex('ArrowDown', 0, 4), 1);
  assert.equal(keyIndex('ArrowUp', 0, 4), 0);
  assert.equal(keyIndex('PageDown', 1, 40), 13);
  assert.equal(keyIndex('PageDown', 1, 4), 3);
  assert.equal(keyIndex('Home', 3, 4), 0);
  assert.equal(keyIndex('End', 0, 4), 3);
  assert.equal(keyIndex('a', 0, 4), null);
});

test('текущий месяц: первая секция, нижний край которой ниже линии шапки', () => {
  const s = [{ key: '2026-05', bottom: 40 }, { key: '2026-03', bottom: 500 }, { key: '2025-12', bottom: 900 }];
  assert.equal(currentKey(s, 112), '2026-03');
  assert.equal(currentKey(s, 2000), '2025-12');
  assert.equal(currentKey([], 112), null);
});
