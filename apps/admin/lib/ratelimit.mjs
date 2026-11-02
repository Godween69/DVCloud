// Ограничение неудачных попыток входа: не больше max за окно.
export function createLimiter({ max, windowMs, now = Date.now }) {
  const hits = new Map();
  const recent = (key) => {
    const list = (hits.get(key) ?? []).filter((t) => now() - t < windowMs);
    hits.set(key, list);
    return list;
  };
  return {
    blocked: (key) => recent(key).length >= max,
    fail: (key) => recent(key).push(now()),
    reset: (key) => hits.delete(key),
  };
}
