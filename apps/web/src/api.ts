import type { Album, AlbumRef, Challenge, FactorStatus, FileItem, LoginResult, SimilarResult, Usage, User } from './types';

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
  list: (trashed: boolean, before?: string) => {
    const q = new URLSearchParams({ limit: '200' });
    if (trashed) q.set('trashed', '1');
    if (before) q.set('before', before);
    return request<{ files: FileItem[]; next: string | null }>('GET', `/api/files?${q}`);
  },
  usage: () => request<Usage>('GET', '/api/files/usage'),
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
  albumOf: (fileId: string) => request<{ album: AlbumRef | null }>('GET', `/api/albums/of-file/${fileId}`).then((r) => r.album),
};

// Миниатюра для плиток: маленький WebP, который сервер строит сам (для видео и неразбираемых форматов её нет).
export const thumbUrl = (id: string): string => `/api/files/${id}/thumb`;

export const fileUrl = (id: string, download = false): string => `/api/files/${id}${download ? '?download=1' : ''}`;

// Загрузка одного файла с прогрессом. Тело запроса это сам файл (см. docs/FILES.md).
export function sendFile(file: File, onProgress: (fraction: number) => void): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/files?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-File-Modified', String(file.lastModified));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
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
    xhr.send(file);
  });
}
