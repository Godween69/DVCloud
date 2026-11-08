import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qrModules, qrPath } from '../src/lib/qr.ts';

test('QR: матрица квадратная, три поисковых узора в углах, результат стабилен', () => {
  const m = qrModules('dvchat://auth#eyJjIjoiYWJjIn0');
  const n = m.length;
  assert.ok(n >= 21 && (n - 17) % 4 === 0); // размеры QR: 21, 25, 29, ...
  assert.ok(m.every((row) => row.length === n));
  // Левый верхний, правый верхний и левый нижний углы: тёмная рамка 7 модулей, тёмный центр 3x3.
  for (const [r, c] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    for (let k = 0; k < 7; k++) assert.ok(m[r][c + k] && m[r + 6][c + k] && m[r + k][c] && m[r + k][c + 6]);
    for (let a = 2; a <= 4; a++) for (let b = 2; b <= 4; b++) assert.ok(m[r + a][c + b]);
    assert.ok(!m[r + 1][c + 1] && !m[r + 1][c + 2]); // светлое кольцо между рамкой и центром
  }
  assert.deepEqual(qrModules('dvchat://auth#eyJjIjoiYWJjIn0'), m);
  assert.notDeepEqual(qrModules('dvchat://auth#другое'), m);
});

test('QR: путь SVG покрывает ровно тёмные модули', () => {
  const m = qrModules('otpauth://totp/DV%20Cloud:anna?secret=GEZDGNBVGY3TQOJQ&issuer=DV%20Cloud');
  const dark = m.flat().filter(Boolean).length;
  const area = [...qrPath(m).matchAll(/h(\d+)v1/g)].reduce((s, x) => s + Number(x[1]), 0);
  assert.equal(area, dark);
});
