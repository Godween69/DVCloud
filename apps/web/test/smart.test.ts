import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_RATIO, MAX_RATIO, MIN_RATIO, bento, ratioOf, targetHeight } from '../src/lib/smart.ts';

const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i), ratio: [1.5, 0.75, 1, 1.78, 0.56][i % 5] }));

test('вертикальный кадр занимает две клетки в высоту, горизонтальный две в ширину', () => {
  const b = bento([{ id: 'v', ratio: 0.7 }, { id: 'h', ratio: 1.6 }, { id: 's', ratio: 1 }], 900, 180, 4);
  assert.deepEqual(b.items.map((x) => [x.cs, x.rs]), [[1, 2], [2, 1], [1, 1]]);
});

test('каждый девятый снимок крупный 2x2, но узкий вертикальный остаётся столбиком', () => {
  const b = bento(mk(30), 900, 180, 4);
  const big = b.items.filter((x) => x.cs === 2 && x.rs === 2).map((x) => Number(x.id));
  assert.ok(big.length >= 2);
  for (const i of big) assert.equal(i % 9, 4);
});

test('размер плитки в пикселях сходится с клетками и промежутками', () => {
  const b = bento(mk(20), 1000, 180, 4);
  for (const x of b.items) {
    assert.equal(x.w, x.cs * b.cell + 4 * (x.cs - 1));
    assert.equal(x.h, x.rs * b.cell + 4 * (x.rs - 1));
  }
  assert.ok(b.cols * b.cell + 4 * (b.cols - 1) <= 1000);
});

test('колонок не меньше трёх и все снимки на месте', () => {
  const b = bento(mk(50), 300, 180, 4);
  assert.ok(b.cols >= 3);
  assert.equal(b.items.length, 50);
  assert.deepEqual(bento([], 800, 180, 4).items, []);
});

test('раскладка не меняется от подгрузки снимков в конец', () => {
  const a = bento(mk(20), 900, 180, 4).items;
  const c = bento(mk(40), 900, 180, 4).items.slice(0, 20);
  assert.deepEqual(a, c);
});

test('пропорции: известные ограничиваются, неизвестные берутся по умолчанию', () => {
  assert.equal(ratioOf(4000, 3000), 4 / 3);
  assert.equal(ratioOf(10000, 1000), MAX_RATIO);
  assert.equal(ratioOf(1000, 10000), MIN_RATIO);
  assert.equal(ratioOf(null, null), DEFAULT_RATIO);
  assert.equal(ratioOf(null, null, true), 16 / 9);
});

test('желаемая высота меньше на телефоне', () => {
  assert.ok(targetHeight('m', 400) < targetHeight('m', 1200));
});
