// Ответы сервера DVCloud (см. docs/FILES.md).
export interface FileItem {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  takenAt: string;
  createdAt: string;
  trashedAt: string | null;
  width?: number | null; // размеры снимка (нужны «Умной плитке»), могут быть неизвестны
  height?: number | null;
}

// Похожие фото (см. docs/SIMILAR.md): группа, лучший снимок первым
export interface SimilarFile extends FileItem {
  width: number;
  height: number;
  sharpness: number;
  suggestRemove: boolean;
}
export interface SimilarGroup {
  id: string;
  files: SimilarFile[];
}
export interface SimilarResult {
  groups: SimilarGroup[];
  images: number; // сколько фото в библиотеке
  ready: number; // для скольких уже посчитан отпечаток
}

export interface User {
  id: string;
  login: string;
  displayName: string;
  isAdmin: boolean;
  quotaBytes: number | null;
}

export interface Usage {
  usedBytes: number;
  quotaBytes: number | null;
  count: number;
}

export interface Album {
  id: string;
  name: string;
  count: number;
  coverFileId: string | null;
  createdAt: string;
  mine: boolean; // false: альбом чужой, им поделились
  ownerName: string | null;
  sharedWith: number;
  show: AlbumShow; // где файлы альбома видны в ленте (внутри самого альбома видны всегда)
}

export interface AlbumShow {
  library: boolean;
  photos: boolean;
  videos: boolean;
  screenshots: boolean;
}

export interface Person {
  login: string;
  displayName: string;
}

export type ClaimState = 'linked' | 'restored' | 'mine' | 'unknown' | 'quota' | 'bad';
export interface ClaimResult {
  sha256: string;
  state: ClaimState;
  file?: FileItem;
}

export interface Estimate {
  usedBytes: number;
  quotaBytes: number | null;
  freeBytes: number | null;
  needBytes: number;
  fits: boolean;
}

export interface UploadSession {
  id: string;
  offset: number;
  size: number;
  chunk: number;
}

export interface AlbumRef {
  id: string;
  name: string;
}

// Вход: либо сразу человек, либо нужен второй шаг (талон и способы).
export type LoginResult = { user: User } | { ticket: string; methods: string[] };

export interface Challenge {
  challenge: string;
  number: string;
  qr: string;
  expiresIn: number;
}

// Состояние второго фактора. available = false: на сервере облака DV Auth не подключён.
export interface FactorStatus {
  available: boolean;
  enabled?: boolean;
  chatAvailable?: boolean;
  chatLinked?: boolean;
  matrixId?: string | null;
  totpAvailable?: boolean;
  totpEnabled?: boolean;
  recoveryLeft?: number;
}

// Поиск по смыслу (см. docs/SEARCH.md)
export interface SearchStatus {
  enabled: boolean; // включён администратором
  available: boolean; // и служба поиска отвечает
  total: number; // файлов в библиотеке, которые должны попасть в поиск
  indexed: number; // из них уже готовых к поиску
}
export interface SearchResult {
  people?: FoundPerson[]; // кого узнали по словам запроса («Валя»)
  files: FileItem[]; // от самого подходящего к менее подходящим
  indexed: number;
  total: number;
}

// Люди и питомцы (см. docs/PEOPLE.md)
export interface PeopleGroup {
  id: string;
  name: string | null; // null: группа ещё не названа
  kind: 'person' | 'pet';
  hidden: boolean;
  count: number; // файлов
  cover: string; // номер находки для обложки
}
export interface PeopleList {
  enabled: { faces: boolean; pets: boolean };
  people: PeopleGroup[];
}
export interface FaceBox {
  id: string;
  kind: 'face' | 'cat' | 'dog';
  box: [number, number, number, number]; // доли картинки: x, y, ширина, высота
  personId: string | null;
  name: string | null;
}
export interface FoundPerson {
  id: string;
  name: string;
}

// Раздел «Яндекс Диск» (см. docs/YANDEX.md).
export type YandexItemState = 'new' | 'queued' | 'done' | 'waiting' | 'failed' | 'skipped';
export interface YandexStatus {
  enabled: boolean;
  connected: boolean;
  state?: 'connected' | 'expired';
  list?: { state: 'idle' | 'running' | 'error'; note: string | null; at: string | null };
  counts?: Record<YandexItemState, number>;
  bytes?: { total: number; done: number; remaining: number };
  years?: { year: number | null; n: number; bytes: number; todo: number }[];
  import?: { state: 'idle' | 'running' | 'paused'; note: string | null; intoAlbum: boolean; current: { name: string; size: number; got: number } | null; speed: number; etaSec: number | null };
  sync?: { auto: boolean; days: number; autoImport: boolean; at: string | null; found: number | null; foundBytes: number | null; pending: number };
  quota?: { freeBytes: number | null; needBytes: number; fits: boolean };
}
export interface YandexItem {
  name: string;
  size: number;
  takenHint: string | null;
  state: YandexItemState;
  error: string | null;
  fileId: string | null;
}
