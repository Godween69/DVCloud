// Мелкие чистые помощники для выбора файлов и скачивания подборок.

// Адрес скачивания подборки в ZIP. Номера идут в адресе, поэтому их число ограничено (см. MAX_ZIP_IDS).
export const MAX_ZIP_IDS = 800;

export function zipHref(ids: string[], name: string): string {
  const q = new URLSearchParams({ ids: ids.join(',') });
  if (name) q.set('name', name);
  return `/api/zip?${q}`;
}

export const albumZipHref = (albumId: string): string => `/api/albums/${albumId}/zip`;

// Новый набор с переключённым элементом (исходный не меняется, чтобы React увидел изменение).
export function toggled(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

// Добавляет или убирает сразу несколько элементов.
export function setMany(set: ReadonlySet<string>, ids: string[], on: boolean): Set<string> {
  const next = new Set(set);
  for (const id of ids) {
    if (on) next.add(id);
    else next.delete(id);
  }
  return next;
}
