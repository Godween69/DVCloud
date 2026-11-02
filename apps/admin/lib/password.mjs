// Пароли: scrypt со случайной солью, сравнение за постоянное время. Без зависимостей.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const N = 16384;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32, { N });
  return `scrypt$${N}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [kind, n, saltHex, keyHex] = String(stored).split('$');
  if (kind !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, { N: Number(n) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
