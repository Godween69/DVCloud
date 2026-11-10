// Типы альбомов: универсальный принимает всё, остальные только своё. Порядок по умолчанию: универсальные, фото, видео, скриншоты.
import type { Album, AlbumKind } from '../types';

export const KIND_LABEL: Record<AlbumKind, string> = { any: 'Универсальный', photos: 'Фото', videos: 'Видео', screenshots: 'Скриншоты' };
export const KIND_ORDER: AlbumKind[] = ['any', 'photos', 'videos', 'screenshots'];

// Чем меньше число, тем выше в списке. Если известно, что кладём (fit), подходящий тип идёт первым, потом универсальные, потом остальные.
export function kindRank(k: AlbumKind, fit?: Exclude<AlbumKind, 'any'>): number {
  if (fit) return k === fit ? 0 : k === 'any' ? 1 : 2 + KIND_ORDER.indexOf(k);
  return KIND_ORDER.indexOf(k);
}

// Альбомы для полоски на вкладке: только свои нужного типа, избранные первыми, потом тяжёлые. Список с сервера уже так упорядочен.
export function stripAlbums(all: Album[] | null, kind: Exclude<AlbumKind, 'any'>, max = 4): { shown: Album[]; total: number } {
  const mine = (all ?? []).filter((a) => a.mine && a.kind === kind);
  return { shown: mine.slice(0, max), total: mine.length };
}
