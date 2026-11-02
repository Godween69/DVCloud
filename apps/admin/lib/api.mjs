// Клиент внутреннего порта сервера DVCloud. Токен уходит только в заголовке.
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function messageOf(json) {
  const m = json && json.message;
  if (Array.isArray(m)) return m.join('; ');
  return typeof m === 'string' ? m : null;
}

export function createApi({ baseUrl, token, fetchImpl = fetch }) {
  async function call(method, path, body) {
    let r;
    try {
      r = await fetchImpl(baseUrl + path, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new ApiError(0, 'Сервер DVCloud недоступен');
    }
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* не JSON */
    }
    if (!r.ok) throw new ApiError(r.status, messageOf(json) ?? `Ошибка сервера (${r.status})`);
    return json;
  }
  const u = (login) => `/internal/users/${encodeURIComponent(login)}`;
  return {
    list: async () => (await call('GET', '/internal/users')).users,
    create: (login, displayName) => call('POST', '/internal/users', { login, displayName }),
    update: (login, patch) => call('PATCH', u(login), patch),
    reset: (login) => call('POST', `${u(login)}/reset-password`, {}),
  };
}
