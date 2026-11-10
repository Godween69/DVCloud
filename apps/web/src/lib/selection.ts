// Массовый выбор в сетке: диапазон (Shift). Здесь только чистые вычисления.

// Номера файлов между a и b включительно в порядке показа. Если одного из них нет в списке, возвращается только b (или пусто).
export function rangeIds(order: readonly string[], a: string, b: string): string[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (j < 0) return [];
  if (i < 0) return [b];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}
