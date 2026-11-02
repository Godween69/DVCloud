// Человекочитаемый размер файла: 1536 -> "1,5 КБ".
const UNITS = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];

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
