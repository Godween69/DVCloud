// Разбор и показ дат для конструктора альбомов (чистые функции, без React).

export const parseIso = (v: string): Date | undefined => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v); return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : undefined; };
export const showDate = (v: string) => (v ? v.split('-').reverse().join('.') : '');
// «1.10.2018», «01.10.18», «2018-10-01» -> «2018-10-01»; пусто или неразборчиво -> null
export function readDate(raw: string, final: boolean): string | null {
  const t = raw.trim();
  let m = /^(\d{1,2})[.\/ -](\d{1,2})[.\/ -](\d{4}|\d{2})$/.exec(t);
  let y: number, mo: number, d: number;
  if (m) { d = Number(m[1]); mo = Number(m[2]); y = Number(m[3]); if (y < 100) { if (!final) return null; y += 2000; } }
  // (двузначный год принимается только после ввода: иначе «1.10.20» оборвало бы набор «2018»)
  else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t))) { y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]); }
  else return null;
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d && y >= 1990 ? iso(dt) : null;
}
export const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
