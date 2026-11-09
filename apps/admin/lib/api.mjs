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
    reset2fa: (login) => call('POST', `${u(login)}/reset-2fa`, {}),
    deleteUser: (login, force) => call('DELETE', `${u(login)}${force ? '?force=1' : ''}`),
    stats: () => call('GET', '/internal/stats'),
    orphans: async () => (await call('GET', '/internal/files/orphans?limit=200')).orphans,
    purge: (id) => call('POST', `/internal/files/${encodeURIComponent(id)}/purge`, {}),
    purgeOrphans: (confirm) => call('POST', '/internal/files/orphans/purge', { confirm }),
    adopt: (id, login) => call('POST', `/internal/files/${encodeURIComponent(id)}/adopt`, { login }),
    dedupe: (apply) => call('POST', '/internal/files/dedupe', { limit: 100, apply }),
    albums: async () => (await call('GET', '/internal/albums')).albums,
    duplicates: (offset = 0, limit = 50) => call('GET', `/internal/duplicates?offset=${offset}&limit=${limit}`),
    scanDuplicates: () => call('POST', '/internal/duplicates/scan', {}),
    mergeDuplicates: (keep, drop) => call('POST', '/internal/duplicates/merge', { keep, drop }),
    applyDuplicates: (decisions) => call('POST', '/internal/duplicates/apply', { decisions }),
    deletedAlbums: async () => (await call('GET', '/internal/albums-deleted')).albums,
    restoreAlbum: (id) => call('POST', `/internal/albums/${encodeURIComponent(id)}/restore`, {}),
    purgeAlbum: (id) => call('DELETE', `/internal/albums-deleted/${encodeURIComponent(id)}`),
    deleteAlbum: (id) => call('DELETE', `/internal/albums/${encodeURIComponent(id)}`),
    transfer: (id, login, move) => call('POST', `/internal/albums/${encodeURIComponent(id)}/transfer`, { login, move }),
    transferPreview: (id) => call('GET', `/internal/albums/${encodeURIComponent(id)}/transfer-preview`),
    media: () => call('GET', '/internal/media'),
    dates: async () => (await call('GET', '/internal/media/dates')).job,
    startDates: (apply) => call('POST', '/internal/media/dates', { apply }),
    saveMedia: (patch) => call('PATCH', '/internal/media/settings', patch),
    clearMedia: (what) => call('POST', '/internal/media/clear', { what }),
    // Пересборка и подсчёт групп идут в фоне: сервер отвечает сразу, ход виден в обзоре медиа (peopleJob).
    rebuildPeople: () => call('POST', '/internal/media/people/rebuild', {}),
    peopleHint: () => call('POST', '/internal/media/people/hint', {}),
    // Просмотр файлов: только чтение. Фильтры: login, from, to (YYYY-MM-DD), q, album, before, limit.
    browse: (f) => call('GET', '/internal/browse/files?' + new URLSearchParams(Object.entries(f).filter(([, v]) => v !== undefined && v !== '')).toString()),
    // Карточка файла и соседи под тем же фильтром.
    fileInfo: (id, f) => call('GET', `/internal/browse/files/${encodeURIComponent(id)}/info?` + new URLSearchParams(Object.entries({ login: f.login, from: f.from, to: f.to, q: f.q, album: f.album }).filter(([, v]) => v)).toString()),
    // Раздача альбомов.
    albumShares: async (id) => (await call('GET', `/internal/albums/${encodeURIComponent(id)}/shares`)).logins,
    share: (id, login) => call('PUT', `/internal/albums/${encodeURIComponent(id)}/shares/${encodeURIComponent(login)}`, undefined),
    unshare: (id, login) => call('DELETE', `/internal/albums/${encodeURIComponent(id)}/shares/${encodeURIComponent(login)}`),
    unshareAll: (id) => call('DELETE', `/internal/albums/${encodeURIComponent(id)}/shares`),
    vault: async () => (await call('GET', '/internal/vault')).albums,
    toVault: (id, note) => call('POST', `/internal/albums/${encodeURIComponent(id)}/to-vault`, { note }),
    vaultReturn: (id, login) => call('POST', `/internal/vault/${encodeURIComponent(id)}/return`, { login }),
    vaultErase: (id) => call('DELETE', `/internal/vault/${encodeURIComponent(id)}`),
    shareAll: (id) => call('POST', `/internal/albums/${encodeURIComponent(id)}/share-all`, {}),
    shareEverything: () => call('POST', '/internal/share-everything', { confirm: true }),
    // Сырой ответ (миниатюра или сам файл) для передачи в браузер как есть; Range пробрасывается, чтобы видео перематывалось.
    raw: async (path, range) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 10000);
      try {
        return await fetchImpl(baseUrl + path, { headers: { authorization: `Bearer ${token}`, ...(range ? { range } : {}) }, signal: ctl.signal });
      } catch {
        throw new ApiError(0, 'Сервер DVCloud недоступен');
      } finally {
        clearTimeout(timer);
      }
    },
    // Резервная копия: настройки места, проверка, запуск по кнопке и ход.
    backup: () => call('GET', '/internal/backup'),
    saveBackup: (patch) => call('PATCH', '/internal/backup/config', patch),
    checkBackup: () => call('POST', '/internal/backup/check', {}),
    startBackup: () => call('POST', '/internal/backup/start', {}),
    requests: async () => (await call('GET', '/internal/quota-requests')).requests,
    resolveRequest: (id) => call('POST', `/internal/quota-requests/${encodeURIComponent(id)}/resolve`, {}),
  };
}
