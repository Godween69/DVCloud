import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Шифрование секретов в базе: AES-256-GCM. Ключ получается из DVCLOUD_SECRETS_KEY (длинная случайная строка).
// Формат: версия (1 байт) | nonce (12) | метка (16) | шифртекст. Подмена или чужой ключ дают ошибку при расшифровке.
const VERSION = 1;

const keyOf = (secret: string): Buffer => createHash('sha256').update(`dvcloud-secrets-v1\n${secret}`).digest();

export function seal(secret: string, value: unknown): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyOf(secret), nonce);
  const body = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return Buffer.concat([Buffer.from([VERSION]), nonce, c.getAuthTag(), body]);
}

export function open<T = unknown>(secret: string, blob: Buffer): T {
  if (blob.length < 30 || blob[0] !== VERSION) throw new Error('Неизвестный формат секрета');
  const d = createDecipheriv('aes-256-gcm', keyOf(secret), blob.subarray(1, 13));
  d.setAuthTag(blob.subarray(13, 29));
  return JSON.parse(Buffer.concat([d.update(blob.subarray(29)), d.final()]).toString('utf8')) as T;
}
