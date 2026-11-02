import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../lib/password.mjs';

test('верный пароль проходит, неверный нет', () => {
  const h = hashPassword('correct horse');
  assert.ok(verifyPassword('correct horse', h));
  assert.ok(!verifyPassword('wrong', h));
});

test('соль случайная: два хеша одного пароля различаются', () => {
  assert.notEqual(hashPassword('x'), hashPassword('x'));
});

test('битый хеш не проходит и не падает', () => {
  assert.ok(!verifyPassword('x', 'garbage'));
  assert.ok(!verifyPassword('x', ''));
});
