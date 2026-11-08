import type { FaceBox, PeopleGroup } from '../types';

// Подпись рамки: имя, если известно, иначе вопрос.
export function faceLabel(f: Pick<FaceBox, 'kind' | 'name'>): string {
  if (f.name) return f.name;
  return f.kind === 'face' ? 'Кто это?' : f.kind === 'cat' ? 'Чей кот?' : 'Чья собака?';
}

export interface Rect { left: number; top: number; width: number; height: number }

// Рамка в пикселях относительно окна просмотра: img и stage это getBoundingClientRect() (с учётом масштаба и сдвига).
export function boxRect(box: [number, number, number, number], img: Rect, stage: Rect): Rect {
  const [x, y, w, h] = box;
  return { left: img.left - stage.left + x * img.width, top: img.top - stage.top + y * img.height, width: w * img.width, height: h * img.height };
}

// Подсказки при вводе имени: сначала начинающиеся с введённого, потом содержащие. Лица к людям, звери к питомцам.
export function suggest(list: PeopleGroup[], text: string, kind: FaceBox['kind'], max = 6): PeopleGroup[] {
  const want = kind === 'face' ? 'person' : 'pet';
  const q = text.trim().toLowerCase();
  const named = list.filter((p) => p.kind === want && p.name);
  if (!q) return named.slice(0, max);
  const starts = named.filter((p) => p.name!.toLowerCase().startsWith(q));
  const has = named.filter((p) => !p.name!.toLowerCase().startsWith(q) && p.name!.toLowerCase().includes(q));
  return [...starts, ...has].slice(0, max);
}

// Есть ли уже человек с таким именем (без учёта регистра): тогда ввод означает «это он», а не новая группа.
export function sameName(list: PeopleGroup[], text: string, kind: FaceBox['kind']): PeopleGroup | null {
  const want = kind === 'face' ? 'person' : 'pet';
  const q = text.trim().toLowerCase();
  return q ? list.find((p) => p.kind === want && p.name?.toLowerCase() === q) ?? null : null;
}

// Сначала названные (по числу файлов), потом безымянные группы.
export function sortGroups(list: PeopleGroup[]): PeopleGroup[] {
  return [...list].sort((a, b) => Number(!!b.name) - Number(!!a.name) || b.count - a.count);
}
