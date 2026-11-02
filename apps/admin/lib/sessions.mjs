// Сессии админки в памяти: после перезапуска админки нужно войти заново. Это нормально для локальной панели.
import { randomBytes } from 'node:crypto';

export function createSessions({ idleMs = 30 * 60 * 1000, maxMs = 12 * 60 * 60 * 1000, now = Date.now } = {}) {
  const map = new Map();
  return {
    create() {
      const s = { token: randomBytes(32).toString('base64url'), csrf: randomBytes(24).toString('base64url'), createdAt: now(), seenAt: now(), flash: null };
      map.set(s.token, s);
      return s;
    },
    get(token) {
      const s = token ? map.get(token) : undefined;
      if (!s) return null;
      if (now() - s.seenAt > idleMs || now() - s.createdAt > maxMs) {
        map.delete(token);
        return null;
      }
      s.seenAt = now();
      return s;
    },
    destroy(token) {
      map.delete(token);
    },
  };
}
