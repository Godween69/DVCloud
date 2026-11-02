import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SCALE, NO_ZOOM, clampPan, zoomAt } from '../src/lib/zoom.ts';

test('масштаб растёт и не выходит за пределы', () => {
  let v = NO_ZOOM;
  for (let i = 0; i < 50; i++) v = zoomAt(v, 1.5, 0, 0);
  assert.equal(v.scale, MAX_SCALE);
  for (let i = 0; i < 50; i++) v = zoomAt(v, 0.5, 0, 0);
  assert.deepEqual(v, NO_ZOOM);
});

test('точка под курсором остаётся на месте при увеличении', () => {
  const px = 120, py = -40;
  const before = zoomAt(NO_ZOOM, 2, 10, 10);
  const after = zoomAt(before, 1.7, px, py);
  // координата точки на самой картинке: (курсор - сдвиг) / масштаб
  assert.ok(Math.abs((px - before.x) / before.scale - (px - after.x) / after.scale) < 1e-9);
  assert.ok(Math.abs((py - before.y) / before.scale - (py - after.y) / after.scale) < 1e-9);
});

test('сдвиг ограничен краями, а без увеличения равен нулю', () => {
  const v = clampPan({ scale: 2, x: 9999, y: -9999 }, 400, 300);
  assert.deepEqual(v, { scale: 2, x: 400, y: -300 });
  assert.deepEqual(clampPan({ scale: 1, x: 50, y: 50 }, 400, 300), NO_ZOOM);
});
