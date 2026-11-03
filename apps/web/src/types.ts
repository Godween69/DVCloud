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
