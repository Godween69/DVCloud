import { useMemo } from 'react';
import { qrModules, qrPath } from '../lib/qr';

// QR-код как SVG. Фон всегда белый, а модули тёмные, даже в тёмной теме: так его читают камеры.
export function QrCode({ value, label, size = 208 }: { value: string; label: string; size?: number }) {
  const { n, d } = useMemo(() => {
    const m = qrModules(value);
    return { n: m.length, d: qrPath(m) };
  }, [value]);
  const quiet = 3; // белое поле вокруг (по стандарту 4, для экрана хватает 3)
  return (
    <svg role="img" aria-label={label} viewBox={`${-quiet} ${-quiet} ${n + quiet * 2} ${n + quiet * 2}`} width={size} height={size} shapeRendering="crispEdges" className="rounded-xl bg-white">
      <path d={d} fill="#111827" />
    </svg>
  );
}
