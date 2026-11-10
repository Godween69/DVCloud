// «Умная плитка»: снимки разных форм идут вперемешку, крупные и мелкие (как в Яндекс Фото).
// Чистая функция без страницы, поэтому проверяется обычными тестами.

export interface SmartInput {
  id: string;
  ratio: number; // ширина / высота снимка
}

export interface SmartBox {
  id: string;
  w: number;
  h: number;
}

// Слишком вытянутые снимки (панорамы, длинные скриншоты) не должны ломать ряд: пропорция ограничивается.
export const MIN_RATIO = 0.55;
export const MAX_RATIO = 2.4;
// Если пропорции файла ещё не известны (видео, только что загруженное), берём обычный кадр.
export const DEFAULT_RATIO = 4 / 3;

export function ratioOf(width: number | null | undefined, height: number | null | undefined, video = false): number {
  if (width && height && width > 0 && height > 0) return Math.min(MAX_RATIO, Math.max(MIN_RATIO, width / height));
  return video ? 16 / 9 : DEFAULT_RATIO;
}

export interface BentoItem {
  id: string;
  cs: number; // сколько клеток занимает по ширине
  rs: number; // сколько клеток по высоте
  w: number; // размер плитки в пикселях
  h: number;
}
export interface Bento {
  cols: number;
  cell: number;
  items: BentoItem[];
}

// «Умная плитка» как в Яндекс Фото: сетка из одинаковых клеток, а снимок занимает одну или несколько клеток по своей форме.
// Вертикальный кадр встаёт столбиком на две клетки в высоту, горизонтальный занимает две клетки в ширину, обычный одну,
// а каждый девятый (кроме узких вертикальных) растягивается на 2x2 и становится «крупным». Так крупные и мелкие снимки идут
// вперемешку, а пустоты закрывает плотная укладка (grid-auto-flow: dense). Решение зависит только от формы снимка и его номера,
// поэтому раскладка не прыгает при подгрузке новых файлов в конец.
export function bento(items: SmartInput[], width: number, target: number, gap: number): Bento {
  const cols = Math.max(3, Math.min(12, Math.round((width + gap) / (target + gap))));
  const cell = width > 0 ? Math.floor((width - gap * (cols - 1)) / cols) : target;
  let run = 0; // сколько вертикальных кадров подряд (чтобы у человека с одними вертикальными снимками не вышла стена одинаковых столбиков)
  const out = items.map((it, i): BentoItem => {
    let cs = 1;
    let rs = 1;
    if (it.ratio < 0.8) {
      // Обычный вертикальный кадр (3:4 с телефона): два столбика, затем крупный 2x2, затем маленький квадрат, и по кругу.
      // Узкий вертикальный (длинный скриншот) всегда остаётся столбиком, чтобы его не обрезало.
      const k = run % 4;
      run++;
      if (it.ratio < 0.62 || k < 2) rs = 2;
      else if (k === 2) { cs = 2; rs = 2; }
    } else {
      run = 0;
      if (it.ratio >= 1.35) cs = 2;
      if (i % 9 === 4) { cs = 2; rs = 2; }
    }
    return { id: it.id, cs, rs, w: cs * cell + gap * (cs - 1), h: rs * cell + gap * (rs - 1) };
  });
  return { cols, cell, items: out };
}

// Желаемая высота ряда по размеру плиток и ширине экрана: на телефоне ряды ниже.
export function targetHeight(density: 's' | 'm' | 'l', width: number): number {
  const base = { s: 120, m: 180, l: 260 }[density];
  return width < 520 ? Math.round(base * 0.62) : width < 900 ? Math.round(base * 0.82) : base;
}
