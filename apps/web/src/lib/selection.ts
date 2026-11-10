// Массовый выбор в сетке: диапазон (Shift), протягивание мышью, рамка. Здесь только чистые вычисления.

// Номера файлов между a и b включительно в порядке показа. Если одного из них нет в списке, возвращается только b (или пусто).
export function rangeIds(order: readonly string[], a: string, b: string): string[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (j < 0) return [];
  if (i < 0) return [b];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

// Что изменить, чтобы выбранное протягиванием стало равно next, если сейчас применено prev:
// add — отметить (или снять, смотря на режим), remove — вернуть как было.
export function dragDiff(prev: ReadonlySet<string>, next: ReadonlySet<string>): { add: string[]; remove: string[] } {
  const add: string[] = [];
  const remove: string[] = [];
  for (const id of next) if (!prev.has(id)) add.push(id);
  for (const id of prev) if (!next.has(id)) remove.push(id);
  return { add, remove };
}

export interface Box { left: number; top: number; right: number; bottom: number }

// Пересекаются ли два прямоугольника.
export function boxesHit(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

// Прямоугольник по двум точкам (в любом порядке углов).
export function boxOf(x1: number, y1: number, x2: number, y2: number): Box {
  return { left: Math.min(x1, x2), top: Math.min(y1, y2), right: Math.max(x1, x2), bottom: Math.max(y1, y2) };
}
