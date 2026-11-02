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
