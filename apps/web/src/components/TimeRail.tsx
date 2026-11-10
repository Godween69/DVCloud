import { useEffect, useRef, useState } from 'react';
import { countFiles } from '../lib/format';
import { bubbleTitle, centerOf, indexAt, indexOfKey, keyIndex, thinMarks, yearMarks, type Month } from '../lib/timeline';

interface Props {
  months: Month[]; // новые сверху
  current: string | null; // месяц, который сейчас на экране ("2026-03")
  onPick: (index: number) => void;
}

// Полоса времени у правого края: тянуть или нажимать, пойдёт ближайший месяц. Подпись с датой появляется возле пальца.
export function TimeRail({ months, current, onPick }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [drag, setDrag] = useState<number | null>(null); // месяц под пальцем, пока полоса зажата
  const [hover, setHover] = useState<number | null>(null);
  const [kbd, setKbd] = useState<number | null>(null); // месяц, выбранный клавишами, пока не ушли
  const n = months.length;
  const cur = current ? indexOfKey(months, current) : 0;
  const shown = drag ?? kbd ?? hover;
  const at = (clientY: number): number => {
    const r = box.current?.getBoundingClientRect();
    return r && r.height > 0 ? indexAt((clientY - r.top) / r.height, n) : 0;
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const marks = thinMarks(yearMarks(months), n, 0.045);
  const pct = (i: number) => `${(centerOf(i, n) * 100).toFixed(2)}%`;
  const bubble = shown !== null && months[shown] ? months[shown] : null;

  return (
    <div ref={box} role="slider" tabIndex={0} aria-label="Полоса времени" aria-orientation="vertical" aria-valuemin={0} aria-valuemax={n - 1} aria-valuenow={shown ?? cur} aria-valuetext={months[shown ?? cur] ? bubbleTitle(months[shown ?? cur]) : undefined}
      data-testid="time-rail" className="fixed bottom-20 right-0 top-32 sm:bottom-6 z-20 w-9 cursor-pointer touch-none select-none rounded-l-xl outline-offset-0 hover:bg-paper-200/60 focus-visible:bg-paper-200/60 sm:w-11 dark:hover:bg-gray-900/60 dark:focus-visible:bg-gray-900/60"
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDrag(at(e.clientY)); }}
      onPointerMove={(e) => { if (drag !== null) setDrag(at(e.clientY)); else if (e.pointerType === 'mouse') setHover(at(e.clientY)); }}
      onPointerUp={(e) => { if (drag === null) return; const i = at(e.clientY); setDrag(null); setHover(null); onPick(i); }}
      onPointerCancel={() => setDrag(null)} onPointerLeave={() => setHover(null)}
      onBlur={() => setKbd(null)}
      onKeyDown={(e) => {
        const i = keyIndex(e.key, kbd ?? cur, n);
        if (i === null) return;
        e.preventDefault();
        setKbd(i);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => { setKbd(null); onPick(i); }, 400);
      }}>
      <div className="pointer-events-none absolute inset-y-0 right-2 w-px bg-paper-300 dark:bg-gray-700" />
      {marks.map((k) => (
        <span key={k.y} className="pointer-events-none absolute right-3.5 -translate-y-1/2 text-[10px] font-medium leading-none text-gray-500 sm:text-[11px]" style={{ top: pct(k.index) }}>{k.y}</span>
      ))}
      <span className="pointer-events-none absolute right-[3px] h-4 w-[7px] -translate-y-1/2 rounded-full bg-violet-600 shadow transition-[top] duration-200 ease-out motion-reduce:transition-none" style={{ top: pct(shown ?? cur) }} />
      <div aria-hidden className={`pointer-events-none absolute right-full mr-2 -translate-y-1/2 whitespace-nowrap rounded-lg bg-violet-600 px-2.5 py-1 text-sm font-medium text-white transition-[opacity,transform] duration-150 motion-reduce:transition-none ${bubble ? 'scale-100 opacity-100' : 'scale-90 opacity-0'}`} style={{ top: pct(shown ?? cur) }} data-testid="time-bubble">
        {bubble ? `${bubbleTitle(bubble)} · ${countFiles(bubble.n)}` : ''}
      </div>
    </div>
  );
}
