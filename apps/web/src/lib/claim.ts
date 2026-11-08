import { api } from '../api';
import type { ClaimResult } from '../types';

// SHA-256 файла. Нужен защищённый контекст (https), иначе null и файл просто грузится целиком.
export async function sha256Hex(file: Blob): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function claimFile(file: File): Promise<ClaimResult | null> {
  const sha = await sha256Hex(file);
  if (!sha) return null;
  const [r] = await api.claim([{ sha256: sha, name: file.name, modified: String(file.lastModified) }]);
  return r ?? null;
}
