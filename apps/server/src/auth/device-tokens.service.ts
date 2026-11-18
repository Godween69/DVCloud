import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes, verify } from 'node:crypto';
import { DbService } from '../db/db.service';
import { CONFIG } from '../tokens';
import type { Config } from '../config';

const MAX_DEVICES_PER_USER = 1;
const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000; // ±5 минут
const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();

function buildSignatureBase(method: string, path: string, ts: string, nonce: string, body: string): string {
  return `${method}\n${path}\n${ts}\n${nonce}\n${createHash('sha256').update(body).digest('hex')}`;
}

// Кэш nonce в памяти процесса: защита от replay-атак
const nonceCache = new Map<string, number>();

@Injectable()
export class DeviceTokensService {
  constructor(
    private readonly db: DbService,
    @Inject(CONFIG) private readonly cfg: Config,
  ) {}

  // Создание токена устройства. Если активное устройство уже есть — 409.
  async createDevice(userId: string, deviceName: string, devicePubkeyBase64: string): Promise<string> {
    const existing = await this.db.query(
      'SELECT id FROM device_tokens WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
    );
    if (existing.rows.length >= MAX_DEVICES_PER_USER) {
      throw new HttpException(
        'Устройство уже привязано. Отзовите старое в настройках безопасности.',
        HttpStatus.CONFLICT,
      );
    }
    const token = `dvc_${randomBytes(32).toString('base64url')}`;
    const pubkeyDer = Buffer.from(devicePubkeyBase64, 'base64');
    await this.db.query(
      'INSERT INTO device_tokens (user_id, token_hash, device_name, device_pubkey) VALUES ($1, $2, $3, $4)',
      [userId, sha256(token), deviceName, pubkeyDer],
    );
    return token;
  }

  // Аутентификация по Bearer-токену с проверкой ECDSA-подписи.
  async authenticate(
    token: string,
    method: string,
    path: string,
    tsHeader: string | undefined,
    nonceHeader: string | undefined,
    signatureHeader: string | undefined,
    body: string,
    ip: string,
  ): Promise<{ userId: string; deviceId: string } | null> {
    if (!token.startsWith('dvc_') || !tsHeader || !nonceHeader || !signatureHeader) return null;

    const hash = sha256(token);
    const r = await this.db.query<{ user_id: string; id: string; device_pubkey: Buffer }>(
      `SELECT t.id, t.user_id, t.device_pubkey
         FROM device_tokens t
         JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = $1
          AND t.revoked_at IS NULL
          AND NOT u.disabled`,
      [hash],
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0];

    // Проверка timestamp (окно ±5 минут)
    const ts = parseInt(tsHeader, 10);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts * 1000) > TIMESTAMP_WINDOW_MS) return null;

    // Проверка nonce (кэш 5 минут)
    const nonceKey = `${row.id}:${nonceHeader}`;
    if (nonceCache.has(nonceKey)) return null;
    nonceCache.set(nonceKey, Date.now());
    const now = Date.now();
    for (const [k, v] of nonceCache) {
      if (now - v > TIMESTAMP_WINDOW_MS) nonceCache.delete(k);
    }

    // Проверка ECDSA P-256 подписи (DER-формат, как выдаёт Android Keystore)
    try {
      const sigBase = buildSignatureBase(method, path, tsHeader, nonceHeader, body);
      const valid = verify(
        'sha256',
        Buffer.from(sigBase),
        { key: row.device_pubkey, format: 'der', type: 'spki' },
        Buffer.from(signatureHeader, 'base64'),
      );
      if (!valid) return null;
    } catch {
      return null;
    }

    // Обновление last_seen_at (не чаще раза в минуту, чтобы не нагружать БД)
    await this.db.query(
      "UPDATE device_tokens SET last_seen_at = now(), last_ip = $2 WHERE id = $1 AND last_seen_at < now() - interval '1 minute'",
      [row.id, ip],
    );
    return { userId: row.user_id, deviceId: row.id };
  }

  async listForUser(userId: string): Promise<any[]> {
    const r = await this.db.query(
      `SELECT id, device_name, created_at, last_seen_at, last_ip, revoked_at
         FROM device_tokens
        WHERE user_id = $1
        ORDER BY revoked_at IS NULL DESC, created_at DESC`,
      [userId],
    );
    return r.rows;
  }

  async revoke(deviceId: string, userId: string): Promise<void> {
    const r = await this.db.query(
      'UPDATE device_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
      [deviceId, userId],
    );
    if (r.rowCount === 0) throw new HttpException('Устройство не найдено или уже отозвано', HttpStatus.NOT_FOUND);
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.db.query(
      'UPDATE device_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
    );
  }
}
