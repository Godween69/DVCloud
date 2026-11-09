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
  async function call(method, path, body, timeoutMs = 10000) {
    let r;
    try {
      r = await fetchImpl(baseUrl + path, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
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
    reset2fa: (login) => call('POST', `${u(login)}/reset-2fa`, {}),
    deleteUser: (login, force) => call('DELETE', `${u(login)}${force ? '?force=1' : ''}`),
    stats: () => call('GET', '/internal/stats'),
    orphans: async () => (await call('GET', '/internal/files/orphans?limit=200')).orphans,
    purge: (id) => call('POST', `/internal/files/${encodeURIComponent(id)}/purge`, {}),
    purgeOrphans: (confirm) => call('POST', '/internal/files/orphans/purge', { confirm }),
    adopt: (id, login) => call('POST', `/internal/files/${encodeURIComponent(id)}/adopt`, { login }),
    dedupe: (apply) => call('POST', '/internal/files/dedupe', { limit: 100, apply }),
    albums: async () => (await call('GET', '/internal/albums')).albums,
    deleteAlbum: (id) => call('DELETE', `/internal/albums/${encodeURIComponent(id)}`),
    transfer: (id, login, move) => call('POST', `/internal/albums/${encodeURIComponent(id)}/transfer`, { login, move }),
    media: () => call('GET', '/internal/media'),
    dates: async () => (await call('GET', '/internal/media/dates')).job,
    startDates: (apply) => call('POST', '/internal/media/dates', { apply }),
    saveMedia: (patch) => call('PATCH', '/internal/media/settings', patch),
    clearMedia: (what) => call('POST', '/internal/media/clear', { what }),
    // Пересборка и подсчёт групп на десятках тысяч лиц идут минуты: ожидание длиннее обычных 10 секунд.
    rebuildPeople: () => call('POST', '/internal/media/people/rebuild', {}, 300000),
    peopleHint: () => call('GET', '/internal/media/people/hint', undefined, 300000),
    requests: async () => (await call('GET', '/internal/quota-requests')).requests,
    resolveRequest: (id) => call('POST', `/internal/quota-requests/${encodeURIComponent(id)}/resolve`, {}),
  };
}
