// Поиск похожих фото: чистые функции без базы и диска (проверяются обычными тестами).
//
// Два уровня:
//  - дубликаты: то же фото в худшем качестве (уменьшено, пережато): dHash почти совпадает, пропорции те же;
//  - серии: кадры одного момента, снятые подряд: близко по времени и похожи по уменьшенной цветной копии.

export const SIZE = 256; // сторона, до которой уменьшается картинка перед расчётом отпечатков

export interface Fingerprint {
  dhash: Buffer; // 8 байт
  tiny: Buffer; // 192 байта (8x8 RGB)
  width: number;
  height: number;
  sharpness: number;
}

export interface Item extends Fingerprint {
  id: string;
  size: number; // размер файла в байтах
  takenAt: number; // миллисекунды
}

// ---------------------------------------------------------------- отпечатки из пикселей

// Уменьшение усреднением по площади (box): устойчиво к пережатию и масштабу.
export function boxResize(src: Uint8Array, w: number, h: number, ch: number, tw: number, th: number): Uint8Array {
  const out = new Uint8Array(tw * th * ch);
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor((ty * h) / th);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * h) / th));
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor((tx * w) / tw);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * w) / tw));
      for (let c = 0; c < ch; c++) {
        let sum = 0;
        let n = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { sum += src[(y * w + x) * ch + c]; n++; }
        out[(ty * tw + tx) * ch + c] = Math.round(sum / n);
      }
    }
  }
  return out;
}

export function toGray(rgb: Uint8Array, w: number, h: number): Uint8Array {
  const g = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = Math.round(0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2]);
  return g;
}

// dHash: сетка 9x8, бит = «левый пиксель ярче правого». 64 бита.
export function dHash(gray: Uint8Array, w: number, h: number): Buffer {
  const s = boxResize(gray, w, h, 1, 9, 8);
  const out = Buffer.alloc(8);
  let bit = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (s[y * 9 + x] > s[y * 9 + x + 1]) out[bit >> 3] |= 0x80 >> (bit & 7);
      bit++;
    }
  }
  return out;
}

// Резкость: дисперсия лапласиана по серой картинке (чем резче, тем больше).
export function sharpness(gray: Uint8Array, w: number, h: number): number {
  if (w < 3 || h < 3) return 0;
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      sum += v;
      sum2 += v * v;
      n++;
    }
  }
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

export function fingerprintFromRgb(rgb: Uint8Array, w: number, h: number, origW: number, origH: number): Fingerprint {
  const gray = toGray(rgb, w, h);
  return {
    dhash: dHash(gray, w, h),
    tiny: Buffer.from(boxResize(rgb, w, h, 3, 8, 8)),
    width: origW,
    height: origH,
    sharpness: sharpness(gray, w, h),
  };
}

// ---------------------------------------------------------------- сравнение

const POP = Uint8Array.from({ length: 256 }, (_, i) => { let c = 0; for (let v = i; v; v >>= 1) c += v & 1; return c; });

export function hamming(a: Buffer, b: Buffer): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += POP[a[i] ^ b[i]];
  return d;
}

// Средняя разность цветов двух уменьшенных копий, с поправкой на общую яркость каждой (экспозиция может чуть плавать).
export function tinyDiff(a: Buffer, b: Buffer): number {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
  ma /= a.length;
  mb /= b.length;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - ma - (b[i] - mb));
  return d / a.length;
}

const ratio = (i: Item) => i.width / i.height;
export function sameShape(a: Item, b: Item, tol = 0.02): boolean {
  return Math.abs(ratio(a) / ratio(b) - 1) <= tol;
}

class Dsu {
  private p = new Map<string, string>();
  find(x: string): string {
    let r = this.p.get(x) ?? x;
    if (r !== x) { r = this.find(r); this.p.set(x, r); }
    return r;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.p.set(ra, rb);
  }
}

function groupsOf(items: Item[], dsu: Dsu, min: number): Item[][] {
  const by = new Map<string, Item[]>();
  for (const it of items) {
    const r = dsu.find(it.id);
    const g = by.get(r);
    if (g) g.push(it); else by.set(r, [it]);
  }
  return [...by.values()].filter((g) => g.length >= min);
}

// ---------------------------------------------------------------- дубликаты

export interface DuplicateOpts {
  maxHamming: number; // до скольких из 64 бит dHash могут отличаться
  maxTinyDiff: number; // потолок средней разности цветов
}
// Дубликат это ТОТ ЖЕ кадр (другое разрешение или пережатие), поэтому пороги строгие: соседние кадры серии
// (камеру чуть сдвинули) дубликатами считаться не должны, их ищет findSeries. Подбор по настоящим фото: нужен прогон на ваших.
export const DEFAULT_DUP: DuplicateOpts = { maxHamming: 5, maxTinyDiff: 1.2 };

// Поиск без перебора всех пар: 64 бита делятся на 8 байт; при различии не более 6 бит
// хотя бы 2 байта совпадут целиком (принцип Дирихле), поэтому кандидаты ищутся по совпавшему байту.
export function findDuplicates(items: Item[], opts: DuplicateOpts = DEFAULT_DUP): Item[][] {
  const buckets = new Map<number, Item[]>();
  for (const it of items) for (let k = 0; k < 8; k++) {
    const key = (k << 8) | it.dhash[k];
    const b = buckets.get(key);
    if (b) b.push(it); else buckets.set(key, [it]);
  }
  const dsu = new Dsu();
  for (const b of buckets.values()) {
    if (b.length < 2) continue;
    for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) {
      const x = b[i];
      const y = b[j];
      if (hamming(x.dhash, y.dhash) <= opts.maxHamming && sameShape(x, y) && tinyDiff(x.tiny, y.tiny) <= opts.maxTinyDiff) dsu.union(x.id, y.id);
    }
  }
  return groupsOf(items, dsu, 2);
}

// Какую копию оставить: больше пикселей, потом больше размер файла, потом резче. Первый в списке = оставить.
export function rankForQuality(group: Item[]): Item[] {
  return [...group].sort((a, b) => b.width * b.height - a.width * a.height || b.size - a.size || b.sharpness - a.sharpness || Number(a.id) - Number(b.id));
}

// ---------------------------------------------------------------- серии

export interface SeriesOpts {
  maxGapMs: number; // между соседними кадрами серии не больше этого времени
  maxTinyDiff: number; // кадры похожи, если средняя разность цветов не больше
  minSize: number; // серия от скольких кадров
}
export const DEFAULT_SERIES: SeriesOpts = { maxGapMs: 120_000, maxTinyDiff: 16, minSize: 3 };

export function findSeries(items: Item[], opts: SeriesOpts = DEFAULT_SERIES): Item[][] {
  const sorted = [...items].sort((a, b) => a.takenAt - b.takenAt || Number(a.id) - Number(b.id));
  const dsu = new Dsu();
  // «Окно» по времени: цепочка кадров, где каждый следующий не позже maxGapMs после предыдущего.
  let start = 0;
  for (let i = 1; i <= sorted.length; i++) {
    if (i === sorted.length || sorted[i].takenAt - sorted[i - 1].takenAt > opts.maxGapMs) {
      const win = sorted.slice(start, i);
      for (let a = 0; a < win.length; a++) for (let b = a + 1; b < win.length; b++) {
        if (sameShape(win[a], win[b]) && tinyDiff(win[a].tiny, win[b].tiny) <= opts.maxTinyDiff) dsu.union(win[a].id, win[b].id);
      }
      start = i;
    }
  }
  return groupsOf(sorted, dsu, opts.minSize);
}

// Лучшие кадры серии: резкость с поправкой на разрешение. Сколько оставить: примерно каждый десятый, от 1 до 3.
export function rankForSeries(group: Item[]): { ranked: Item[]; keep: number } {
  const maxPx = Math.max(...group.map((g) => g.width * g.height));
  const score = (g: Item) => g.sharpness * ((g.width * g.height) / maxPx);
  const ranked = [...group].sort((a, b) => score(b) - score(a) || Number(a.id) - Number(b.id));
  return { ranked, keep: Math.min(3, Math.max(1, Math.round(group.length / 10))) };
}
