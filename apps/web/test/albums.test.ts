import { test } from 'node:test';
import assert from 'node:assert/strict';
import { albumZipHref, setMany, toggled, zipHref } from '../src/lib/albums.ts';

test('адрес архива подборки', () => {
  assert.equal(zipHref(['1', '22', '333'], 'Отпуск'), '/api/zip?ids=1%2C22%2C333&name=%D0%9E%D1%82%D0%BF%D1%83%D1%81%D0%BA');
  assert.equal(zipHref(['5'], ''), '/api/zip?ids=5');
  assert.equal(albumZipHref('7'), '/api/albums/7/zip');
});

test('выбор: переключение не меняет исходный набор', () => {
  const a = new Set(['1']);
  const b = toggled(a, '2');
  assert.deepEqual([...a], ['1']);
  assert.deepEqual([...b].sort(), ['1', '2']);
  assert.deepEqual([...toggled(b, '1')], ['2']);
});

test('выбор месяца целиком и снятие', () => {
  const a = setMany(new Set(['9']), ['1', '2', '3'], true);
  assert.deepEqual([...a].sort(), ['1', '2', '3', '9']);
  assert.deepEqual([...setMany(a, ['1', '2', '3'], false)], ['9']);
});

test('запомненный быстрый альбом: принимаются только настоящие записи', async () => {
  const { parseTarget } = await import('../src/lib/quick-target.ts');
  assert.deepEqual(parseTarget('{"id":"12","name":"Отпуск"}'), { id: '12', name: 'Отпуск' });
  assert.equal(parseTarget(null), null);
  assert.equal(parseTarget('мусор'), null);
  assert.equal(parseTarget('{"id":"1; drop","name":"x"}'), null);
  assert.equal(parseTarget('{"id":"5","name":""}'), null);
});
