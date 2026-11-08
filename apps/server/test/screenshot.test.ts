import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeScreenshot } from '../src/files/screenshot';

const f = (format: string, hasExif: boolean, width: number, height: number) => ({ format, hasExif, width, height });

test('скриншот: PNG без данных камеры и JPEG размером с экран телефона', () => {
  assert.ok(looksLikeScreenshot(f('png', false, 1080, 2400)));
  assert.ok(looksLikeScreenshot(f('png', false, 1920, 1080)));
  assert.ok(looksLikeScreenshot(f('jpeg', false, 1170, 2532)));
});

test('фото: данные камеры, обычные пропорции, мелочь', () => {
  assert.ok(!looksLikeScreenshot(f('jpeg', true, 3000, 4000)));
  assert.ok(!looksLikeScreenshot(f('png', true, 1080, 2400)), 'с данными камеры не скриншот');
  assert.ok(!looksLikeScreenshot(f('jpeg', false, 1600, 1200)), 'открытка из мессенджера 4:3');
  assert.ok(!looksLikeScreenshot(f('jpeg', false, 1080, 1080)));
  assert.ok(!looksLikeScreenshot(f('png', false, 120, 120)), 'иконка');
});
