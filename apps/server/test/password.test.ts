import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePassword, hashPassword, verifyPassword } from '../src/auth/password';

test('верный пароль проходит, неверный нет', async () => {
  const h = await hashPassword('correct horse');
  assert.ok(await verifyPassword('correct horse', h));
  assert.ok(!(await verifyPassword('wrong', h)));
});

test('соль случайная: два хеша одного пароля различаются', async () => {
  assert.notEqual(await hashPassword('x'), await hashPassword('x'));
});

test('битый хеш не проходит и не падает', async () => {
  assert.ok(!(await verifyPassword('x', 'garbage')));
  assert.ok(!(await verifyPassword('x', '')));
  assert.ok(!(await verifyPassword('x', 'scrypt$999999999$aa$bb')));
});

test('хеш из админки (apps/admin) читается сервером', async () => {
  // Формат один и тот же: scrypt$N$соль$ключ.
  const { scryptSync } = await import('node:crypto');
  const salt = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const key = scryptSync('pass-from-admin', salt, 32, { N: 16384 });
  assert.ok(await verifyPassword('pass-from-admin', `scrypt$16384$${salt.toString('hex')}$${key.toString('hex')}`));
});

test('сгенерированный пароль: 16 символов без похожих знаков, каждый раз новый', () => {
  const a = generatePassword();
  assert.match(a, /^[abcdefghjkmnpqrstuvwxyz23456789]{16}$/);
  assert.notEqual(a, generatePassword());
});
