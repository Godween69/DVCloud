// Масштабирование и сдвиг фото в просмотрщике. Чистые функции, чтобы их можно было проверить тестами.
export interface View {
  scale: number;
  x: number; // сдвиг в пикселях от центра
  y: number;
}

export const MIN_SCALE = 1;
export const MAX_SCALE = 8;
export const NO_ZOOM: View = { scale: 1, x: 0, y: 0 };

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// Меняет масштаб в `factor` раз так, чтобы точка под курсором (px, py, считая от центра окна) осталась на месте.
export function zoomAt(v: View, factor: number, px: number, py: number): View {
  const scale = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
  if (scale === MIN_SCALE) return NO_ZOOM;
  const k = scale / v.scale;
  return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
}

// Не даёт утащить фото за край: сдвиг не больше, чем нужно, чтобы дойти до краёв увеличенной картинки.
export function clampPan(v: View, imgW: number, imgH: number): View {
  if (v.scale <= MIN_SCALE) return NO_ZOOM;
  const mx = (imgW * v.scale) / 2;
  const my = (imgH * v.scale) / 2;
  return { scale: v.scale, x: clamp(v.x, -mx, mx), y: clamp(v.y, -my, my) };
}
