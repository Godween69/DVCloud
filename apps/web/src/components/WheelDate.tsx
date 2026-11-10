import { ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { iso } from '../lib/dates';

type Part = 'd' | 'm' | 'y';
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const daysIn = (y: number, m: number) => new Date(y, m, 0).getDate();

// Дата колёсиком, как барабан в телефоне: навели на день, месяц или год и крутите колесо мыши. Работают ещё стрелки ↑↓ и набор цифр.
// Пустое поле при первом движении принимает значение `start`; значение всегда держится между min и max.
export function WheelDate({ label, value, min, max, start, onChange }: { label: string; value: string; min: string; max: string; start: string; onChange: (iso: string) => void }) {
  const cur = value || '';
  const [y, m, d] = (cur || start).split('-').map(Number);

  function put(part: Part, delta: number) {
    let ny = y, nm = m, nd = d;
    if (part === 'y') ny += delta;
    else if (part === 'm') { nm += delta; while (nm > 12) { nm -= 12; ny += 1; } while (nm < 1) { nm += 12; ny -= 1; } }
    else nd += delta;
    // день выходит за месяц: переходим в соседний (как в календаре), а не обрезаем
    let t = new Date(ny, nm - 1, 1);
    t = part === 'd' ? new Date(ny, nm - 1, nd) : new Date(t.getFullYear(), t.getMonth(), Math.min(nd, daysIn(t.getFullYear(), t.getMonth() + 1)));
    let r = iso(t);
    if (r < min) r = min;
    if (r > max) r = max;
    onChange(r);
  }
  function type(part: Part, digits: string) {
    let ny = y, nm = m, nd = d;
    const n = Number(digits);
    if (part === 'y') ny = n; else if (part === 'm') nm = n; else nd = n;
    if (nm < 1 || nm > 12 || nd < 1 || ny < 1990 || ny > 2100) return;
    nd = Math.min(nd, daysIn(ny, nm));
    const r = iso(new Date(ny, nm - 1, nd));
    if (r >= min && r <= max) onChange(r);
  }

  const seg = (part: Part, text: string, width: string, aria: string) => <Seg key={part} part={part} text={value ? text : { d: 'дд', m: 'мес', y: 'гггг' }[part]} empty={!value} width={width} aria={`${label}: ${aria}`} put={put} type={type} />;
  return (
    <div className="flex items-center gap-1.5 text-sm" role="group" aria-label={`Дата «${label}»`}>
      <span className="w-4 text-gray-700 dark:text-gray-300">{label}</span>
      <div className="glass flex items-center gap-0.5 rounded-xl px-1 py-0.5">
        {seg('d', String(d).padStart(2, '0'), 'w-9', 'день')}
        {seg('m', MONTHS[m - 1], 'w-12', 'месяц')}
        {seg('y', String(y), 'w-14', 'год')}
      </div>
    </div>
  );
}

function Seg({ part, text, empty, width, aria, put, type }: { part: Part; text: string; empty: boolean; width: string; aria: string; put: (p: Part, d: number) => void; type: (p: Part, digits: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const buf = useRef('');
  const timer = useRef(0);
  const putRef = useRef(put);
  putRef.current = put;
  const [spin, setSpin] = useState<1 | -1 | 0>(0);

  // колесо: React вешает onWheel пассивно, а нам нужно остановить прокрутку страницы
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = (e: WheelEvent) => { e.preventDefault(); const dir = e.deltaY < 0 ? 1 : -1; putRef.current(part, dir); setSpin(dir); window.setTimeout(() => setSpin(0), 120); };
    el.addEventListener('wheel', on, { passive: false });
    return () => el.removeEventListener('wheel', on);
  }, [part]);

  const max = part === 'y' ? 4 : 2;
  return (
    <div ref={ref} role="spinbutton" tabIndex={0} aria-label={aria} aria-valuetext={empty ? 'не выбрано' : text}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') { e.preventDefault(); put(part, 1); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); put(part, -1); }
        else if (/^\d$/.test(e.key)) {
          e.preventDefault();
          buf.current = (buf.current + e.key).slice(-max);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => { buf.current = ''; }, 1200);
          if (buf.current.length === max || (part !== 'y' && Number(buf.current) > (part === 'm' ? 1 : 3))) { type(part, buf.current); buf.current = ''; }
        }
      }}
      className={`group relative flex ${width} cursor-ns-resize select-none flex-col items-center rounded-lg py-0.5 outline-none transition-colors hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-violet-500 dark:hover:bg-white/10 ${empty ? 'text-gray-500 dark:text-gray-400' : 'font-medium text-gray-900 dark:text-white'}`}>
      <ChevronUp className={`size-3 transition-opacity ${spin === 1 ? 'opacity-100' : 'opacity-30 group-hover:opacity-70'}`} aria-hidden />
      <span className="tabular-nums leading-5">{text}</span>
      <ChevronDown className={`size-3 transition-opacity ${spin === -1 ? 'opacity-100' : 'opacity-30 group-hover:opacity-70'}`} aria-hidden />
    </div>
  );
}
