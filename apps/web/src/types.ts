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
