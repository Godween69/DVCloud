import type { Album, AlbumRef, Challenge, ClaimResult, Estimate, PeopleList, FaceBox, Person, UploadSession, FactorStatus, FileItem, LoginResult, SimilarResult, SearchResult, SearchStatus, Usage, User, YandexItem, YandexStatus } from './types';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Вызывается, когда сервер ответил 401 (сессия кончилась): приложение возвращает на экран входа.
let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Сервер недоступен. Проверьте подключение и попробуйте ещё раз.');
  }
  let json: any = null;
  try {
    json = await r.json();
  } catch {
    /* не JSON */
  }
  if (!r.ok) {
    // 401 на проверке пароля или кода (вход, второй шаг, настройки безопасности) означает «неверно», а не «сессия кончилась».
    const soft = path.startsWith('/api/auth/') && !(method === 'GET' && path === '/api/auth/security');
    if (r.status === 401 && !soft) onUnauthorized();
    throw new ApiError(r.status, typeof json?.message === 'string' ? json.message : `Ошибка сервера (${r.status})`);
  }
  return json as T;
}

function timeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

export const api = {
  me: () => request<{ user: User }>('GET', '/api/auth/me').then((r) => r.user),
  login: (login: string, password: string) =>
    request<{ user?: User; twoFactor?: { ticket: string; methods: string[] } }>('POST', '/api/auth/login', { login, password }).then((r): LoginResult =>
      r.twoFactor ? { ticket: r.twoFactor.ticket, methods: r.twoFactor.methods } : { user: r.user as User },
    ),
  twoFactorCode: (ticket: string, code: string) => request<{ user: User }>('POST', '/api/auth/2fa/code', { ticket, code }).then((r) => r.user),
  chatStart: (ticket: string) => request<Challenge>('POST', '/api/auth/2fa/chat/start', { ticket }),
  chatStatus: (ticket: string) => request<{ state: 'pending' | 'approved' | 'failed' | 'none'; user?: User }>('POST', '/api/auth/2fa/chat/status', { ticket }),
  security: () => request<FactorStatus>('GET', '/api/auth/security'),
  totpBegin: (password: string) => request<{ secret: string; uri: string }>('POST', '/api/auth/security/totp/begin', { password }),
  totpEnable: (code: string) => request<{ recoveryCodes: string[] | null }>('POST', '/api/auth/security/totp/enable', { code }),
  totpDisable: (password: string, code?: string) => request<{ ok: true }>('POST', '/api/auth/security/totp/disable', { password, code }),
  recoveryNew: (password: string, code?: string) => request<{ recoveryCodes: string[] }>('POST', '/api/auth/security/recovery/new', { password, code }),
  chatLinkStart: (password: string, code?: string) => request<Challenge>('POST', '/api/auth/security/chat/start', { password, code }),
  chatLinkStatus: () => request<{ state: 'pending' | 'approved' | 'failed' | 'none'; matrixId?: string; recoveryCodes?: string[] | null }>('POST', '/api/auth/security/chat/status', {}),
  chatUnlink: (password: string, code?: string) => request<{ ok: true }>('DELETE', '/api/auth/security/chat', { password, code }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout', {}),
  list: (trashed: boolean, before?: string, kind?: 'photos' | 'videos' | 'screenshots', at?: string, after?: string, person?: string) => {
    const q = new URLSearchParams({ limit: '200' });
    if (trashed) q.set('trashed', '1');
    if (before) q.set('before', before);
    if (kind && !trashed) q.set('kind', kind);
    if (at && !trashed) { q.set('at', at); q.set('tz', timeZone()); }
    if (after && !trashed) q.set('after', after);
    if (person && !trashed) q.set('person', person);
    return request<{ files: FileItem[]; next: string | null; prev?: string | null }>('GET', `/api/files?${q}`);
  },
  // Оглавление ленты по месяцам для полосы времени (месяцы считаются в часовом поясе браузера, как и заголовки месяцев).
  timeline: (kind?: 'photos' | 'videos' | 'screenshots') => {
    const q = new URLSearchParams({ tz: timeZone() });
    if (kind) q.set('kind', kind);
    return request<{ months: { y: number; m: number; n: number }[] }>('GET', `/api/files/timeline?${q}`);
  },
  usage: () => request<Usage>('GET', '/api/files/usage'),
  // Люди и питомцы
  peopleGroups: (hidden = false) => request<PeopleList>('GET', `/api/people${hidden ? '?hidden=1' : ''}`),
  facesOf: (fileId: string) => request<{ faces: FaceBox[] }>('GET', `/api/people/file/${encodeURIComponent(fileId)}`).then((r) => r.faces),
  assignFace: (detectionId: string, personId: string | null) => request<{ ok: true }>('PUT', `/api/people/detections/${encodeURIComponent(detectionId)}`, { personId }),
  createPerson: (detectionId: string, name: string) => request<{ id: string }>('POST', '/api/people', { detectionId, name }),
  renamePerson: (id: string, name: string | null) => request<{ ok: true }>('PATCH', `/api/people/${encodeURIComponent(id)}`, { name }),
  hidePerson: (id: string, hidden: boolean) => request<{ ok: true }>('PATCH', `/api/people/${encodeURIComponent(id)}`, { hidden }),
  mergePeople: (into: string, from: string) => request<unknown>('POST', `/api/people/${encodeURIComponent(into)}/merge`, { from }),
  mergePeopleMany: (into: string, from: string[]) => request<{ merged: number }>('POST', '/api/people/merge-many', { into, from }),
  deletePerson: (id: string) => request<unknown>('DELETE', `/api/people/${encodeURIComponent(id)}`),
  removeFromPerson: (id: string, fileId: string) => request<{ removed: number }>('DELETE', `/api/people/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}`),
  searchStatus: () => request<SearchStatus>('GET', '/api/search/status'),
  yandexStatus: () => request<YandexStatus>('GET', '/api/yandex'),
  yandexConnect: () => request<{ id: string }>('POST', '/api/yandex/connect', {}),
  // QR приходит картинкой; пока помощник не готов, сервер отвечает 204 (null).
  yandexQr: async (id: string): Promise<string | null> => {
    const r = await fetch(`/api/yandex/connect/${id}/qr`, { cache: 'no-store' });
    if (r.status === 204) return null;
    if (!r.ok) throw new ApiError(r.status, 'Не удалось получить QR-код.');
    return URL.createObjectURL(await r.blob());
  },
  yandexConnectStatus: (id: string) => request<{ state: 'waiting' | 'done' | 'failed'; note?: string }>('GET', `/api/yandex/connect/${id}`),
  yandexDisconnect: () => request<{ ok: true }>('DELETE', '/api/yandex'),
  yandexList: () => request<{ ok: true }>('POST', '/api/yandex/list', {}),
  yandexImport: (opts: { years?: (number | null)[]; retryFailed?: boolean; intoAlbum?: boolean }) => request<{ queued: number }>('POST', '/api/yandex/import', opts),
  yandexPause: () => request<{ ok: true }>('POST', '/api/yandex/pause', {}),
  yandexResume: () => request<{ ok: true }>('POST', '/api/yandex/resume', {}),
  yandexItems: (state: string | null, offset: number) => request<{ items: YandexItem[]; total: number }>('GET', `/api/yandex/items?limit=50&offset=${offset}${state ? `&state=${state}` : ''}`),
  search: (q: string) => request<SearchResult>('GET', `/api/search?${new URLSearchParams({ q })}`),
  similar: (kind: 'duplicates' | 'series') => request<SimilarResult>('GET', `/api/similar/${kind}`),
  trash: (id: string) => request<{ file: FileItem }>('DELETE', `/api/files/${id}`),
  restore: (id: string) => request<{ file: FileItem }>('POST', `/api/files/${id}/restore`, {}),
  purge: (id: string) => request<{ ok: true }>('DELETE', `/api/files/${id}?permanent=1`),
  albums: () => request<{ albums: Album[] }>('GET', '/api/albums').then((r) => r.albums),
  albumCreate: (name: string) => request<{ album: Album }>('POST', '/api/albums', { name }).then((r) => r.album),
  albumRename: (id: string, name: string) => request<{ album: Album }>('PATCH', `/api/albums/${id}`, { name }).then((r) => r.album),
  albumDelete: (id: string) => request<{ ok: true }>('DELETE', `/api/albums/${id}`),
  albumFiles: (id: string, before?: string) => {
    const q = new URLSearchParams({ limit: '200' });
    if (before) q.set('before', before);
    return request<{ album: Album; files: FileItem[]; next: string | null }>('GET', `/api/albums/${id}/files?${q}`);
  },
  albumIds: (id: string) => request<{ ids: string[] }>('GET', `/api/albums/${id}/ids`).then((r) => r.ids),
  albumAdd: (id: string, ids: string[]) => request<{ added: number }>('POST', `/api/albums/${id}/add`, { ids }).then((r) => r.added),
  albumRemoveFiles: (id: string, ids: string[]) => request<{ removed: number }>('POST', `/api/albums/${id}/remove`, { ids }).then((r) => r.removed),
  albumOf: (fileId: string) => request<{ album: AlbumRef | null; albums: AlbumRef[] }>('GET', `/api/albums/of-file/${fileId}`).then((r) => r.albums),
  people: () => request<{ people: Person[] }>('GET', '/api/albums/people').then((r) => r.people),
  shares: (id: string) => request<{ people: Person[] }>('GET', `/api/albums/${id}/shares`).then((r) => r.people),
  share: (id: string, login: string) => request<{ ok: true }>('PUT', `/api/albums/${id}/shares/${encodeURIComponent(login)}`, {}),
  unshare: (id: string, login: string) => request<{ ok: true }>('DELETE', `/api/albums/${id}/shares/${encodeURIComponent(login)}`),
  leave: (id: string) => request<{ ok: true }>('POST', `/api/albums/${id}/leave`, {}),
  saveAlbum: (id: string, ids?: string[]) => request<{ added: number; skipped: number; quota: boolean }>('POST', `/api/albums/${id}/save`, ids ? { ids } : {}),
  claim: (items: { sha256: string; name: string; modified?: string }[]) => request<{ results: ClaimResult[] }>('POST', '/api/files/claim', { items }).then((r) => r.results),
  estimate: (bytes: number) => request<Estimate>('POST', '/api/files/estimate', { bytes }),
  quotaRequest: (needBytes: number, note = '') => request<{ ok: true }>('POST', '/api/files/quota-request', { needBytes, note }),
  bulk: (action: 'hide' | 'restore' | 'remove', ids: string[]) => request<{ changed: number }>('POST', '/api/files/bulk', { action, ids }).then((r) => r.changed),
  emptyTrash: () => request<{ removed: number }>('DELETE', '/api/files/trash').then((r) => r.removed),
};

// Миниатюра для плиток: маленький WebP, который сервер строит сам (для видео и неразбираемых форматов её нет).
export const thumbUrl = (id: string): string => `/api/files/${id}/thumb`;

// Превью для просмотра (WebP до 2000 px): грузится в разы быстрее оригинала.
export const previewUrl = (id: string): string => `/api/files/${id}/preview`;

// Видео для просмотра: уменьшенная копия, если её сделал сервер; иначе 404 и плеер берёт оригинал.
export const videoViewUrl = (id: string): string => `/api/files/${id}/view`;
export const cropUrl = (detectionId: string): string => `/api/people/detections/${detectionId}/crop`;
export const fileUrl = (id: string, download = false): string => `/api/files/${id}${download ? '?download=1' : ''}`;

// Один запрос с телом и прогрессом. Возвращает HTTP-статус и разобранный JSON.
function xhrSend(method: string, url: string, body: Blob | null, headers: Record<string, string>, onProgress: (loaded: number) => void): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded);
    };
    xhr.onload = () => {
      let json: any = null;
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        /* не JSON */
      }
      if (xhr.status === 401) onUnauthorized();
      resolve({ status: xhr.status, json });
    };
    xhr.onerror = () => reject(new Error('Сервер недоступен'));
    xhr.ontimeout = () => reject(new Error('Сервер недоступен'));
    xhr.send(body);
  });
}

// Файлы до этого размера уходят одним запросом, большие частями с докачкой.
export const CHUNKED_FROM = 32 * 1024 * 1024;
const RETRIES = 6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Загрузка по частям: после обрыва спрашиваем у сервера, сколько он принял, и продолжаем с этого места.
async function sendChunked(file: File, onProgress: (fraction: number) => void): Promise<{ status: number; json: any }> {
  const jsonHeaders = { 'Content-Type': 'application/json' };
  const startBody = new Blob([JSON.stringify({ name: file.name, size: file.size, modified: String(file.lastModified) })]);
  let started: { status: number; json: any } | null = null;
  for (let i = 0; i < RETRIES && !started; i++) {
    try {
      started = await xhrSend('POST', '/api/uploads', startBody, jsonHeaders, () => {});
    } catch (e) {
      if (i === RETRIES - 1) throw e;
      await sleep(1000 * 2 ** i);
    }
  }
  if (!started || started.status !== 200) return started ?? { status: 0, json: null };
  const s = started.json as UploadSession;
  let offset = s.offset;
  const chunk = Math.max(1024 * 1024, Math.min(s.chunk || 8 * 1024 * 1024, 64 * 1024 * 1024));
  let fails = 0;
  while (offset < file.size) {
    const end = Math.min(file.size, offset + chunk);
    try {
      const r = await xhrSend('PATCH', `/api/uploads/${s.id}`, file.slice(offset, end), { 'Content-Type': 'application/octet-stream', 'Upload-Offset': String(offset) }, (loaded) => onProgress((offset + loaded) / file.size));
      if (r.status === 200 && r.json) {
        fails = 0;
        offset = r.json.offset;
        onProgress(offset / file.size);
        if (r.json.done) return { status: r.json.duplicate ? 200 : 201, json: { file: r.json.file, duplicate: r.json.duplicate === true } };
        continue;
      }
      if (r.status === 409 && typeof r.json?.offset === 'number') {
        offset = r.json.offset; // сервер принял иначе: продолжаем с его места
        continue;
      }
      if (r.status >= 500 || r.status === 0) throw new Error('Сбой сервера');
      return r;
    } catch (e) {
      if (++fails >= RETRIES) throw e instanceof Error ? e : new Error('Сервер недоступен');
      await sleep(Math.min(30000, 1000 * 2 ** fails));
      try {
        const st = await request<UploadSession>('GET', `/api/uploads/${s.id}`);
        offset = st.offset;
      } catch (e2) {
        if (e2 instanceof ApiError && e2.status === 404) throw new Error('Загрузка потеряна, попробуйте ещё раз');
        /* сеть ещё не вернулась: следующий круг попробует снова */
      }
    }
  }
  return { status: 500, json: { message: 'Загрузка не завершилась' } };
}

// Загрузка одного файла с прогрессом. Тело запроса это сам файл (см. docs/FILES.md).
export function sendFile(file: File, onProgress: (fraction: number) => void): Promise<{ status: number; json: any }> {
  if (file.size > CHUNKED_FROM) return sendChunked(file, onProgress);
  return xhrSend('POST', `/api/files?name=${encodeURIComponent(file.name)}`, file, { 'Content-Type': 'application/octet-stream', 'X-File-Modified': String(file.lastModified) }, (loaded) => onProgress(loaded / file.size));
}
