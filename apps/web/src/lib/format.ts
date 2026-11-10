// Человекочитаемые размеры, даты и склонения по-русски.
const UNITS = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];

// 1536 -> "1,5 КБ"
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  let v = n;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const s = i === 0 ? String(Math.round(v)) : v.toFixed(1).replace('.', ',');
  return `${s} ${UNITS[i]}`;
}

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

// "Ноябрь 2026"
export function monthTitle(year: number, monthIndex: number): string {
  return `${MONTHS[monthIndex]} ${year}`;
}

// "12 мая 2026, 14:30" (по местному времени)
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm}`;
}

// plural(1, 'файл', 'файла', 'файлов') -> "файл"; 2 -> "файла"; 5 -> "файлов"; 21 -> "файл"
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

export function countFiles(n: number): string {
  return `${n} ${plural(n, 'файл', 'файла', 'файлов')}`;
}

// Заголовок дня для группировки: «Сегодня», «Вчера» или «12 июня 2026» (по местному времени).
export function dayHeading(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

// Ключ дня для группировки (по местному времени).
export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// Разбить файлы на группы по дню удаления, сохраняя порядок.
export function groupByDay<T extends { trashedAt: string | null }>(items: T[], now = new Date()): { key: string; title: string; items: T[] }[] {
  const out: { key: string; title: string; items: T[] }[] = [];
  for (const it of items) {
    const at = it.trashedAt ?? new Date(0).toISOString();
    const key = dayKey(at);
    const last = out[out.length - 1];
    if (last && last.key === key) last.items.push(it);
    else out.push({ key, title: dayHeading(at, now), items: [it] });
  }
  return out;
}
