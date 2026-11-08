import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXAMPLES, indexNote } from '../src/lib/search.ts';

const st = (o: Partial<{ enabled: boolean; available: boolean; total: number; indexed: number }> = {}) => ({ enabled: true, available: true, total: 100, indexed: 100, ...o });

test('подсказка про индекс: молчит, когда всё готово, выключено или статуса нет', () => {
  assert.equal(indexNote(null), '');
  assert.equal(indexNote(st({ enabled: false, indexed: 3 })), '');
  assert.equal(indexNote(st()), '');
  assert.equal(indexNote(st({ total: 0, indexed: 0 })), '');
});

test('подсказка про индекс: сколько уже знает поиск и сколько ещё обрабатывается', () => {
  assert.equal(indexNote(st({ indexed: 60 })), 'Поиск пока знает 60 из 100 файлов. Ещё 40 файлов обрабатывается в фоне, и они появятся в результатах позже.');
  assert.match(indexNote(st({ indexed: 99 })), /Ещё 1 файл обрабатывается/);
  assert.match(indexNote(st({ indexed: 98 })), /Ещё 2 файла обрабатывается/);
});

test('подсказка про индекс: служба недоступна', () => {
  assert.match(indexNote(st({ available: false })), /не отвечает/);
});

test('примеры запросов: русские, не пустые и без повторов', () => {
  assert.ok(EXAMPLES.length >= 4);
  assert.equal(new Set(EXAMPLES).size, EXAMPLES.length);
  for (const x of EXAMPLES) assert.match(x, /[а-яё]/i);
});
