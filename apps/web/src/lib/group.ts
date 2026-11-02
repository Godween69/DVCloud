import type { FileItem } from '../types.ts';
import { monthTitle } from './format.ts';

export interface Group {
  key: string; // "2026-05"
  title: string; // "Май 2026"
  items: FileItem[];
}

// Лента приходит отсортированной (свежие сверху): соседние файлы одного месяца собираются в группу.
export function groupByMonth(files: FileItem[]): Group[] {
  const out: Group[] = [];
  for (const f of files) {
    const d = new Date(f.takenAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const last = out[out.length - 1];
    if (last && last.key === key) last.items.push(f);
    else out.push({ key, title: monthTitle(d.getFullYear(), d.getMonth()), items: [f] });
  }
  return out;
}

// id это число до 18 цифр строкой: сравниваем по длине, потом по строке.
function cmpId(a: string, b: string): number {
  return a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0;
}

// Порядок ленты: дата снимка по убыванию, при равенстве больший id выше.
export function compareFeed(a: FileItem, b: FileItem): number {
  const t = Date.parse(b.takenAt) - Date.parse(a.takenAt);
  return t !== 0 ? t : cmpId(b.id, a.id);
}

// Вставляет файл в ленту на своё место (без повторов по id).
export function insertSorted(list: FileItem[], f: FileItem): FileItem[] {
  if (list.some((x) => x.id === f.id)) return list;
  return [...list, f].sort(compareFeed);
}
