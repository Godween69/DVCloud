import assert from 'node:assert/strict';
import test from 'node:test';
import { etaText, importMode, percentDone, yearsToSend } from '../src/lib/yandex.ts';
import type { YandexStatus } from '../src/types.ts';

const st = (o: Partial<YandexStatus>): YandexStatus => ({ enabled: true, connected: true, ...o });
const counts = (c: Partial<Record<'new' | 'queued' | 'done' | 'waiting' | 'failed' | 'skipped', number>>) => ({ new: 0, queued: 0, done: 0, waiting: 0, failed: 0, skipped: 0, ...c });

test('оставшееся время по-русски', () => {
  assert.equal(etaText(null), '');
  assert.equal(etaText(20), 'меньше минуты');
  assert.equal(etaText(90), '2 мин');
  assert.equal(etaText(3725), '1 ч 2 мин');
  assert.equal(etaText(7200), '2 ч');
  assert.equal(etaText(3 * 86400), '3 дн');
});

test('доля хода: по байтам, без размеров по числу файлов, не больше 100', () => {
  assert.equal(percentDone(st({ bytes: { total: 200, done: 50, remaining: 150 } })), 25);
  assert.equal(percentDone(st({ bytes: { total: 100, done: 300, remaining: 0 } })), 100);
  assert.equal(percentDone(st({ bytes: { total: 0, done: 0, remaining: 0 }, counts: counts({ done: 1, queued: 3 }) })), 25);
  assert.equal(percentDone(st({})), 0);
});

test('годы для сервера: все или ни одного = забрать всё', () => {
  const all = [2024, 2023, null];
  assert.equal(yearsToSend(all, new Set()), undefined);
  assert.equal(yearsToSend(all, new Set(all)), undefined);
  assert.deepEqual(yearsToSend(all, new Set([2023, null])), [2023, null]);
});

test('главная кнопка по состоянию', () => {
  assert.equal(importMode(st({ import: { state: 'running', note: null, intoAlbum: true, current: null, speed: 0, etaSec: null }, counts: counts({ queued: 2 }) })), 'running');
  assert.equal(importMode(st({ import: { state: 'paused', note: 'x', intoAlbum: true, current: null, speed: 0, etaSec: null }, counts: counts({ queued: 2 }) })), 'paused');
  assert.equal(importMode(st({ import: { state: 'idle', note: null, intoAlbum: true, current: null, speed: 0, etaSec: null }, counts: counts({ new: 5 }) })), 'ready');
  assert.equal(importMode(st({ import: { state: 'idle', note: null, intoAlbum: true, current: null, speed: 0, etaSec: null }, counts: counts({ done: 5 }) })), 'nothing');
});
