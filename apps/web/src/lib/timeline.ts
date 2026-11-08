// Полоса времени: чистая арифметика (без React), чтобы её можно было проверить тестами.
import { monthTitle } from './format.ts';

export interface Month {
  y: number;
  m: number; // 1..12
  n: number; // файлов в месяце
}

export const monthKey = (y: number, m: number): string => `${y}-${String(m).padStart(2, '0')}`;

// Положение пальца или курсора (0 сверху, 1 снизу) -> номер месяца в списке (новые сверху, у каждого месяца своя равная высота).
export function indexAt(fraction: number, count: number): number {
  if (count <= 0) return -1;
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  return Math.min(count - 1, Math.floor(f * count));
}

// Середина «своей» клетки месяца на полосе, 0..1.
export function centerOf(index: number, count: number): number {
  return count <= 0 ? 0 : (Math.min(Math.max(index, 0), count - 1) + 0.5) / count;
}

// Номер месяца в списке по ключу "2015-03"; если такого месяца нет, ближайший более ранний (то есть ниже в списке), иначе последний.
export function indexOfKey(months: Month[], key: string): number {
  if (months.length === 0) return -1;
  const i = months.findIndex((x) => monthKey(x.y, x.m) <= key);
  return i === -1 ? months.length - 1 : i;
}

// Подписи годов: год показывается на первом (самом новом) месяце этого года.
export function yearMarks(months: Month[]): { y: number; index: number }[] {
  const out: { y: number; index: number }[] = [];
  months.forEach((x, i) => { if (i === 0 || months[i - 1].y !== x.y) out.push({ y: x.y, index: i }); });
  return out;
}

// Если подписи годов стоят теснее порога (доля высоты), лишние пропускаются: остаются самые новые года и те, что не мешают.
export function thinMarks(marks: { y: number; index: number }[], count: number, minGap: number): { y: number; index: number }[] {
  const out: { y: number; index: number }[] = [];
  let lastPos = -Infinity;
  for (const k of marks) {
    const pos = centerOf(k.index, count);
    if (pos - lastPos >= minGap) { out.push(k); lastPos = pos; }
  }
  return out;
}

// Подпись над пальцем: «март 2015».
export function bubbleTitle(x: Month): string {
  return monthTitle(x.y, x.m - 1).toLowerCase();
}

// Сдвиг месяца клавишами (стрелки на 1, PageUp/PageDown на 12, Home и End).
export function keyIndex(key: string, index: number, count: number): number | null {
  const last = count - 1;
  const d = key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : key === 'ArrowDown' || key === 'ArrowRight' ? 1 : key === 'PageUp' ? -12 : key === 'PageDown' ? 12 : 0;
  if (key === 'Home') return 0;
  if (key === 'End') return Math.max(last, 0);
  if (d === 0) return null;
  return Math.min(Math.max(index + d, 0), Math.max(last, 0));
}

// Какой месяц сейчас на экране: берём первую секцию, нижний край которой ниже линии шапки.
export function currentKey(sections: { key: string; bottom: number }[], line: number): string | null {
  for (const s of sections) if (s.bottom > line) return s.key;
  return sections.length ? sections[sections.length - 1].key : null;
}
