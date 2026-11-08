import type { AlbumRef } from '../types.ts';

// Запомненный «быстрый альбом» из localStorage: берём только то, что похоже на настоящую запись.
export function parseTarget(raw: string | null): AlbumRef | null {
  try {
    const o = JSON.parse(raw ?? '');
    if (o && typeof o.id === 'string' && /^\d{1,18}$/.test(o.id) && typeof o.name === 'string' && o.name.length > 0) return { id: o.id, name: o.name.slice(0, 100) };
  } catch {
    /* пусто или не JSON */
  }
  return null;
}

