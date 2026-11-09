import assert from 'node:assert/strict';
import test from 'node:test';
import { HELP, helpKeyFor } from '../src/lib/help.ts';

test('у каждого раздела справка заполнена: заголовок, суть и пункты', () => {
  for (const [key, t] of Object.entries(HELP)) {
    assert.ok(t.title.length > 2, key);
    assert.ok(t.lead.length > 10, key);
    assert.ok(t.points.length >= 1 && t.points.every((p) => p.length > 10), key);
  }
});

test('для разделов сайта находится своя справка, для незнакомых берётся библиотека', () => {
  for (const v of ['library', 'photos', 'videos', 'screenshots', 'albums', 'people', 'similar', 'trash', 'search', 'security', 'yandex']) assert.equal(helpKeyFor(v), v);
  assert.equal(helpKeyFor('что-то-новое'), 'library');
});

test('в справке нет внутренних слов и написано DVChat без вариантов', () => {
  const text = JSON.stringify(HELP);
  assert.ok(!/ДВ-?\s?чат/i.test(text));
  assert.ok(!/import_state|md5|sha256|Postgres/.test(text));
});
