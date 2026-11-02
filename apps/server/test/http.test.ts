import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asObject, parseCookies, strField } from '../src/http';

test('куки разбираются, мусор пропускается', () => {
  assert.deepEqual(parseCookies('a=1; dvcloud_sid=abc; =x; bad'), { a: '1', dvcloud_sid: 'abc' });
  assert.deepEqual(parseCookies(undefined), {});
});

test('тело запроса должно быть объектом', () => {
  assert.throws(() => asObject(null));
  assert.throws(() => asObject([]));
  assert.throws(() => asObject('x'));
  assert.deepEqual(asObject({ a: 1 }), { a: 1 });
});

test('строковое поле проверяется по длине и типу', () => {
  assert.equal(strField({ a: 'abc' }, 'a', 1, 5), 'abc');
  assert.throws(() => strField({ a: '' }, 'a', 1, 5));
  assert.throws(() => strField({ a: 5 }, 'a', 1, 5));
  assert.throws(() => strField({}, 'a', 1, 5));
});
