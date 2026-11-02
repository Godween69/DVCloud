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
