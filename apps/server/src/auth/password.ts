// Пароли: scrypt со случайной солью, сравнение за постоянное время. Формат совместим с apps/admin.
import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

type ScryptFn = (pw: string, salt: Buffer, len: number, opts: { N: number }) => Promise<Buffer>;
const scryptAsync = promisify(scrypt) as unknown as ScryptFn;
const N = 16384;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 32, { N });
  return `scrypt$${N}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, saltHex, keyHex] = stored.split('$');
  const cost = Number(n);
  if (kind !== 'scrypt' || !saltHex || !keyHex || !Number.isInteger(cost) || cost < 4096 || cost > 65536) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length, { N: cost });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummy: Promise<string> | undefined;
// Хеш-пустышка: проверяем пароль даже для несуществующего логина, чтобы время ответа не выдавало, есть ли такой человек.
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword('dvcloud-dummy-password');
  return dummy;
}

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // без похожих символов (l, 1, o, 0, i)

export function generatePassword(length = 16): string {
  let s = '';
  for (let i = 0; i < length; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}
