import { motion } from 'framer-motion';
import { CalendarDays, Check, CheckSquare, ChevronDown, Film, ImageOff, Images, LayoutGrid, LayoutDashboard, Loader2, Play, Plus, Upload, X, Zap, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { thumbUrl } from '../api';
import { prefetchThumbs } from '../lib/prefetch';
import { currentKey, monthKey, type Month } from '../lib/timeline';
import { TimeRail } from './TimeRail';
import { countFiles, formatDateTime } from '../lib/format';
import { groupByMonth } from '../lib/group';
import { bento, ratioOf, targetHeight } from '../lib/smart';
import { isVideo } from '../lib/media';
import { usePref } from '../lib/prefs';
import type { FileItem } from '../types';

type Layout = 'smart' | 'months' | 'wall';
type Density = 's' | 'm' | 'l';
const LAYOUTS = ['smart', 'months', 'wall'] as const;
const DENSITIES = ['s', 'm', 'l'] as const;

// Размер плиток: на телефоне 4, 3 или 2 в ряд, на широком экране фиксированная сторона плитки.
export const GRID: Record<Density, string> = {
  s: 'grid-cols-4 sm:grid-cols-[repeat(auto-fill,minmax(5.5rem,6.5rem))]',
  m: 'grid-cols-3 sm:grid-cols-[repeat(auto-fill,minmax(8rem,9.5rem))]',
  l: 'grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(12rem,15rem))]',
};

interface Props {
  files: FileItem[];
  loaded: boolean;
  loading: boolean;
  hasMore: boolean;
  error: string | null;
  onMore: () => void;
  onOpen: (id: string) => void;
  onAdd: () => void;
  selecting: boolean;
  selected: ReadonlySet<string>;
  onSelecting: (on: boolean) => void;
  onToggle: (id: string) => void;
  onToggleMany: (ids: string[], on: boolean) => void;
  empty?: ReactNode;
  quick: QuickView | null; // «быстрый альбом»: плюсик на плитках (null: выключен)
  chip: { name: string; on: boolean } | null; // выбранный быстрый альбом для переключателя над сеткой
  onQuickOn: (on: boolean) => void; // включить или выключить быстрый альбом
  onPickQuick: () => void; // открыть выбор быстрого альбома
  rail?: { months: Month[]; at: string | null; hasNewer: boolean; onJump: (at: string | null) => Promise<void>; onNewer: () => Promise<void> } | null; // полоса времени (только в разделах библиотеки)
}

export interface QuickView {
  name: string;
  has: (id: string) => boolean;
  toggle: (id: string) => void;
}

// Видео в ленте выглядит как кадр киноплёнки: по бокам тёмные полосы с перфорацией и крупный значок «играть» по центру.
const HOLES = { backgroundImage: 'repeating-linear-gradient(to bottom, transparent 0 3px, rgba(255,255,255,0.85) 3px 9px, transparent 9px 12px)' };
function FilmFrame() {
  const strip = 'pointer-events-none absolute inset-y-0 z-[1] w-4 bg-black/80';
  return (
    <>
      <span className={`${strip} left-0`} aria-hidden><span className="absolute inset-y-0 left-1 w-2 rounded-[1px] opacity-90" style={HOLES} /></span>
      <span className={`${strip} right-0`} aria-hidden><span className="absolute inset-y-0 right-1 w-2 rounded-[1px] opacity-90" style={HOLES} /></span>
      <span className="pointer-events-none absolute inset-x-4 top-0 z-[1] h-px bg-white/20" aria-hidden />
      <span className="pointer-events-none absolute inset-x-4 bottom-0 z-[1] h-px bg-white/20" aria-hidden />
      <span className="pointer-events-none absolute left-1/2 top-1/2 z-[1] flex size-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white ring-1 ring-white/50">
        <Play className="size-5 fill-current" aria-hidden />
      </span>
    </>
  );
}

export function Tile({ file, onOpen, onPick, selecting, picked, quick, box }: { file: FileItem; onOpen: (id: string) => void; onPick: (id: string) => void; selecting: boolean; picked: boolean; quick: QuickView | null; box?: { w: number; h: number } }) {
  const [broken, setBroken] = useState(false);
  const [ready, setReady] = useState(false); // миниатюра пришла: плавно проявляем её поверх мерцающей заглушки
  // Долгое нажатие пальцем включает выбор (как в Google Фото); следующий за ним «клик» не открывает просмотр.
  const hold = useRef<{ t: ReturnType<typeof setTimeout> | null; fired: boolean }>({ t: null, fired: false });
  const stopHold = () => { if (hold.current.t) { clearTimeout(hold.current.t); hold.current.t = null; } };
  const video = isVideo(file.mime);
  const inQuick = !!quick && quick.has(file.id);
  return (
    <div data-tile={file.id} style={box ? { width: box.w, height: box.h } : undefined} className={`group relative ${box ? 'shrink-0' : 'aspect-square w-full [contain-intrinsic-size:8rem]'} isolate transform-gpu overflow-hidden rounded-xl bg-paper-200 shadow-[0_1px_8px_-3px_rgba(15,23,42,0.35)] ring-1 ring-black/5 [content-visibility:auto] dark:bg-gray-800 dark:ring-white/10 ${ready || broken ? '' : 'dv-shimmer'}`}>
    <button type="button" onClick={() => { if (hold.current.fired) { hold.current.fired = false; return; } onOpen(file.id); }}
      onPointerDown={(e) => { if (e.pointerType !== 'touch' || selecting) return; hold.current.fired = false; stopHold(); hold.current.t = setTimeout(() => { hold.current.fired = true; hold.current.t = null; onPick(file.id); }, 450); }}
      onPointerUp={stopHold} onPointerLeave={stopHold} onPointerCancel={stopHold} onContextMenu={(e) => { if (hold.current.fired) e.preventDefault(); }}
      aria-label={selecting ? `${picked ? 'Снять выбор' : 'Выбрать'}: ${file.name}` : `Открыть: ${file.name}`} aria-pressed={selecting ? picked : undefined} title={`${file.name}, ${formatDateTime(file.takenAt)}`} className="absolute inset-0 block size-full overflow-hidden">
      {broken ? (
        <div className="flex size-full flex-col items-center justify-center gap-2 p-2 text-gray-500 transition-colors group-hover:text-gray-700 dark:text-gray-500 dark:group-hover:text-gray-300">
          {video ? <Film className="size-7" aria-hidden /> : <ImageOff className="size-7" aria-hidden />}
          <span className="line-clamp-2 w-full break-all text-center text-xs">{file.name}</span>
        </div>
      ) : (
        <img src={thumbUrl(file.id, !!box)} alt="" loading="lazy" decoding="async" onLoad={() => setReady(true)} onError={() => setBroken(true)}
          ref={(el) => { if (el && !ready && el.complete && el.naturalWidth > 0) setReady(true); }}
          className={`size-full object-cover will-change-[opacity] transition-[transform,opacity] duration-700 ease-[cubic-bezier(0.25,0.8,0.25,1)] motion-reduce:transition-none group-hover:scale-[1.025] group-hover:delay-[250ms] ${ready ? 'opacity-100' : 'opacity-0'}`} />
      )}
      {video && <FilmFrame />}
      {selecting && (
        <>
          <span className={`pointer-events-none absolute inset-0 transition-colors ${picked ? 'bg-violet-600/25 ring-2 ring-inset ring-violet-500' : 'bg-black/0 group-hover:bg-black/10'}`} />
          <span className={`pointer-events-none absolute left-1.5 top-1.5 flex size-6 items-center justify-center rounded-full border-2 ${picked ? 'border-violet-500 bg-violet-600 text-white' : 'border-white/90 bg-black/30 text-transparent'}`}><Check className="size-3.5" strokeWidth={3} aria-hidden /></span>
        </>
      )}
    </button>
    {!selecting && (
      <button type="button" onClick={() => onPick(file.id)} aria-label={`Выбрать: ${file.name}`} title="Выбрать" className="absolute left-1.5 top-1.5 flex size-6 items-center justify-center rounded-full border-2 border-white/90 bg-black/30 text-transparent opacity-0 transition-opacity hover:bg-violet-600 hover:text-white focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:hidden"><Check className="size-3.5" strokeWidth={3} aria-hidden /></button>
    )}
    {quick && !selecting && (
      <button type="button" onClick={() => quick.toggle(file.id)} aria-pressed={inQuick} aria-label={inQuick ? `Убрать из «${quick.name}»: ${file.name}` : `Добавить в «${quick.name}»: ${file.name}`} title={inQuick ? `Уже в «${quick.name}». Нажмите, чтобы убрать` : `В «${quick.name}»`}
        className={`absolute bottom-1.5 right-1.5 flex size-8 items-center justify-center rounded-full text-white backdrop-blur transition-all focus-visible:opacity-100 active:scale-90 ${inQuick ? 'bg-violet-600 opacity-100 hover:bg-violet-500' : 'bg-black/45 opacity-0 hover:bg-violet-600 group-hover:opacity-100 [@media(hover:none)]:opacity-100'}`}>
        {inQuick ? <Check className="size-4" strokeWidth={3} aria-hidden /> : <Plus className="size-4" strokeWidth={3} aria-hidden />}
      </button>
    )}
    </div>
  );
}

// «Умная плитка» одного месяца: сетка одинаковых клеток, снимки занимают одну или несколько клеток по своей форме.
// Ширина берётся у самого блока и пересчитывается при изменении окна.
function SmartRows({ items, density, render }: { items: FileItem[]; density: Density; render: (f: FileItem, box: { w: number; h: number }) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.floor(el.getBoundingClientRect().width));
    const ro = new ResizeObserver((entries) => setWidth(Math.floor(entries[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const b = useMemo(
    () => bento(items.map((f) => ({ id: f.id, ratio: ratioOf(f.width, f.height, isVideo(f.mime)) })), width, targetHeight(density, width), 4),
    [items, width, density],
  );
  const byId = useMemo(() => new Map(items.map((f) => [f.id, f])), [items]);
  return (
    <div ref={ref} className="min-w-0">
      {width > 0 && (
        <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${b.cols}, ${b.cell}px)`, gridAutoRows: `${b.cell}px`, gridAutoFlow: 'dense' }}>
          {b.items.map((x) => (
            <div key={x.id} style={{ gridColumn: `span ${x.cs}`, gridRow: `span ${x.rs}` }}>
              {render(byId.get(x.id) as FileItem, x)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Gallery({ files, loaded, loading, hasMore, error, onMore, onOpen, onAdd, selecting, selected, onSelecting, onToggle, onToggleMany, empty, quick, chip, onQuickOn, onPickQuick, rail }: Props) {
  const groups = useMemo(() => groupByMonth(files), [files]);
  const [layout, setLayout] = usePref<Layout>('layout', 'smart', LAYOUTS);
  const [jumping, setJumping] = useState<string | null>(null); // месяц, к которому идёт переход: показываем сразу, не дожидаясь ответа сервера
  const [density, setDensity] = usePref<Density>('density', 'm', DENSITIES);
  const di = DENSITIES.indexOf(density);
  const sentinel = useRef<HTMLDivElement>(null);
  const [cur, setCur] = useState<string | null>(null); // месяц на экране (для полосы времени)
  const railMonths = rail && rail.months.length > 1 ? rail.months : null;
  const at = rail?.at ?? null;
  const topSentinel = useRef<HTMLDivElement>(null);
  const anchor = useRef<number | null>(null); // высота страницы до догрузки сверху: по ней возвращаем положение прокрутки
  // В режиме выбора нажатие на плитку отмечает её, а не открывает просмотр.
  const tap = (id: string) => (selecting ? onToggle(id) : onOpen(id));
  // Выбрать фото прямо с плитки: режим выбора включается сам.
  const pick = (id: string) => { if (!selecting) onSelecting(true); onToggle(id); };

  // Когда нижний край списка показался на экране, подгружаем следующую страницу.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && onMore(), { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, files.length, onMore]);

  // Файлы догружаются и сверху (после перехода к месяцу): положение прокрутки сохраняем сами, поэтому встроенное выравнивание браузера выключено.
  useEffect(() => {
    const el = document.documentElement;
    const prev = el.style.overflowAnchor;
    el.style.overflowAnchor = 'none';
    return () => { el.style.overflowAnchor = prev; };
  }, []);
  useLayoutEffect(() => {
    const h = anchor.current;
    if (h === null) return;
    anchor.current = null;
    const d = document.documentElement.scrollHeight - h;
    if (d > 0) window.scrollTo(0, window.scrollY + d);
  }, [files[0]?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const hasNewer = !!rail?.hasNewer;
  const onNewer = rail?.onNewer;
  useEffect(() => {
    const el = topSentinel.current;
    if (!el || !hasNewer || !onNewer) return;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      anchor.current = document.documentElement.scrollHeight;
      void onNewer().finally(() => setTimeout(() => { anchor.current = null; }, 300));
    }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNewer, onNewer, files.length, layout]);

  // Какой месяц сейчас на экране: по положению секций месяцев при прокрутке (раз в кадр).
  useEffect(() => {
    if (!railMonths || layout === 'wall') return;
    let raf = 0;
    const calc = () => {
      raf = 0;
      const secs = [...document.querySelectorAll<HTMLElement>('section[data-month]')].map((s) => ({ key: s.dataset.month as string, bottom: s.getBoundingClientRect().bottom }));
      setCur(currentKey(secs, 120));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(calc); };
    calc();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); if (raf) cancelAnimationFrame(raf); };
  }, [railMonths, layout, files.length]);

  // Фоновая подгрузка миниатюр на следующие два экрана вниз, когда прокрутка остановилась (и после перехода к месяцу).
  useEffect(() => {
    if (!loaded || files.length === 0) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      const h = window.innerHeight;
      const ids: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>('[data-tile]')) {
        const r = el.getBoundingClientRect();
        if (r.top > h * 0.9 && r.top < h * 3) ids.push(el.dataset.tile as string);
        else if (r.top >= h * 3) break;
        if (ids.length >= 120) break;
      }
      if (ids.length) prefetchThumbs(ids, layout === 'smart');
    };
    const onScroll = () => { if (t) clearTimeout(t); t = setTimeout(run, 400); };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); if (t) clearTimeout(t); };
  }, [loaded, files, layout, density]);

  const railEl = railMonths ? (
        <TimeRail months={railMonths} current={jumping ?? cur ?? (at ?? monthKey(railMonths[0].y, railMonths[0].m))} onPick={(i) => {
          const x = railMonths[i];
          const key = monthKey(x.y, x.m);
          // Месяц уже загружен: просто прокручиваем к нему, ничего не перезагружая.
          const sec = layout !== 'wall' ? document.querySelector<HTMLElement>(`section[data-month="${key}"]`) : null;
          if (sec) {
            const top = sec.getBoundingClientRect().top + window.scrollY - 120;
            window.scrollTo({ top: Math.max(0, top), behavior: Math.abs(top - window.scrollY) < 4000 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' });
            return;
          }
          // Месяц ещё не загружен: полоса и экран реагируют сразу (наверх, заглушка вместо старой ленты), а данные приходят в фоне.
          setJumping(key);
          window.scrollTo({ top: 0 });
          void rail?.onJump(i === 0 ? null : key).finally(() => setJumping(null));
        }} />
  ) : null;

  if (!loaded) {
    return (
      <div className={`mx-auto max-w-[1600px] px-3 py-6 sm:px-6 ${railMonths ? 'pr-9 sm:pr-14' : ''}`} aria-busy="true" aria-label={jumping ? 'Открываем выбранный месяц' : 'Загружаем библиотеку'}>
        {railEl}
        {jumping && <p role="status" className="mb-3 flex items-center gap-2 text-sm text-gray-500"><Loader2 className="size-4 animate-spin" aria-hidden />Открываем выбранный месяц…</p>}
        <div className={`grid gap-1 ${GRID.m}`}>
          {Array.from({ length: 18 }, (_, i) => (
            <div key={i} className="aspect-square animate-pulse rounded-md bg-paper-200 dark:bg-gray-900" />
          ))}
        </div>
        {error && <p role="alert" className="mt-6 text-center text-red-600 dark:text-red-400">{error}</p>}
      </div>
    );
  }

  if (files.length === 0) {
    if (empty) return <>{empty}</>;
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mx-auto flex max-w-md flex-col items-center px-4 py-24 text-center">
        <span className="mb-5 flex size-16 items-center justify-center rounded-2xl bg-violet-600/10 text-violet-600 dark:text-violet-400">
          <Images className="size-8" aria-hidden />
        </span>
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Здесь пока пусто</h2>
        <p className="mt-2 text-gray-600 dark:text-gray-400">Перетащите фото и видео в окно браузера или нажмите «Добавить».</p>
        <button type="button" onClick={onAdd} className="mt-6 flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 font-medium text-white transition-colors hover:bg-violet-500">
          <Upload className="size-4" aria-hidden />
          Добавить файлы
        </button>
      </motion.div>
    );
  }

  const seg = (on: boolean) => `flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm transition-colors ${on ? 'bg-paper-200 text-gray-900 dark:bg-gray-800 dark:text-white' : 'text-gray-500 hover:text-gray-900 dark:hover:text-white'}`;
  const step = 'flex size-8 items-center justify-center rounded-md text-gray-500 transition-colors hover:text-gray-900 disabled:opacity-30 dark:hover:text-white';

  return (
    <div className={`mx-auto max-w-[1600px] px-3 pb-24 pt-4 sm:px-6 ${railMonths ? 'pr-9 sm:pr-14' : ''}`}>
      {railEl}
      <div className="sticky top-14 z-10 -mx-3 mb-3 flex items-center justify-end gap-3 bg-paper-100/95 px-3 py-2 sm:-mx-6 sm:px-6 dark:bg-gray-950/95">
        {selecting ? (
          <div className="mr-auto flex items-center gap-1">
            <button type="button" onClick={() => onSelecting(false)} aria-label="Отменить выбор" title="Отменить выбор" className="flex size-9 items-center justify-center rounded-full text-gray-700 transition-colors hover:bg-paper-200 dark:text-gray-200 dark:hover:bg-gray-800"><X className="size-5" aria-hidden /></button>
            <span className="text-base font-semibold text-gray-900 dark:text-white" aria-live="polite">{selected.size === 0 ? 'Выберите фото' : `Выбрано: ${countFiles(selected.size)}`}</span>
          </div>
        ) : (
          <>
            <button type="button" onClick={() => onSelecting(true)} className={seg(false)}><CheckSquare className="size-4" aria-hidden /><span>Выбрать</span></button>
            {chip ? (
              <div className={`mr-auto flex min-w-0 items-center rounded-lg border transition-colors ${chip.on ? 'border-violet-500/60 bg-violet-600/10' : 'border-paper-300 dark:border-gray-700'}`}>
                <button type="button" onClick={onPickQuick} title="Выбрать другой альбом" className={`flex min-w-0 items-center gap-1.5 py-1.5 pl-2.5 pr-1.5 text-sm font-medium ${chip.on ? 'text-violet-800 dark:text-violet-200' : 'text-gray-500'}`}>
                  <Zap className="size-4 shrink-0" aria-hidden /><span className="truncate"><span className="hidden sm:inline">Быстрый альбом: </span>{chip.name}</span><ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden />
                </button>
                <button type="button" role="switch" aria-checked={chip.on} aria-label="Быстрый альбом" onClick={() => onQuickOn(!chip.on)} title={chip.on ? 'Выключить быстрый альбом' : 'Включить быстрый альбом'} className="flex items-center px-2 py-2">
                  <span className={`relative h-5 w-9 rounded-full transition-colors ${chip.on ? 'bg-violet-600' : 'bg-gray-300 dark:bg-gray-700'}`}><span className={`absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow transition-transform ${chip.on ? 'translate-x-4' : ''}`} /></span>
                </button>
              </div>
            ) : (
              <button type="button" onClick={onPickQuick} title="Выбрать альбом, в который фото кладутся одним нажатием" className="mr-auto flex min-w-0 items-center gap-1.5 rounded-lg border border-dashed border-paper-300 px-2.5 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:border-violet-400 hover:text-violet-700 dark:border-gray-700 dark:text-gray-300 dark:hover:text-violet-300">
                <Zap className="size-4 shrink-0" aria-hidden /><span className="truncate">Быстрый альбом</span>
              </button>
            )}
          </>
        )}
        <div className="flex items-center rounded-lg border border-paper-300 p-0.5 dark:border-gray-800" role="group" aria-label="Размер плиток">
          <button type="button" className={step} disabled={di === 0} onClick={() => setDensity(DENSITIES[di - 1])} aria-label="Мельче" title="Мельче"><ZoomOut className="size-4" aria-hidden /></button>
          <button type="button" className={step} disabled={di === DENSITIES.length - 1} onClick={() => setDensity(DENSITIES[di + 1])} aria-label="Крупнее" title="Крупнее"><ZoomIn className="size-4" aria-hidden /></button>
        </div>
        <div className="flex items-center rounded-lg border border-paper-300 p-0.5 dark:border-gray-800" role="group" aria-label="Режим показа">
          <button type="button" className={seg(layout === 'smart')} aria-pressed={layout === 'smart'} onClick={() => setLayout('smart')}><LayoutDashboard className="size-4" aria-hidden /><span className="hidden sm:inline">Умная плитка</span></button>
          <button type="button" className={seg(layout === 'months')} aria-pressed={layout === 'months'} onClick={() => setLayout('months')}><CalendarDays className="size-4" aria-hidden /><span className="hidden sm:inline">По месяцам</span></button>
          <button type="button" className={seg(layout === 'wall')} aria-pressed={layout === 'wall'} onClick={() => setLayout('wall')}><LayoutGrid className="size-4" aria-hidden /><span className="hidden sm:inline">Сплошная лента</span></button>
        </div>
      </div>
      <div ref={topSentinel} aria-hidden className="h-px" />
      {layout === 'wall' ? (
        <div className={`grid gap-1 ${GRID[density]}`}>
          {files.map((f) => (
            <Tile key={f.id} file={f} onOpen={tap} onPick={pick} selecting={selecting} picked={selected.has(f.id)} quick={quick} />
          ))}
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.key} data-month={g.key} aria-label={g.title} className="mb-8 lg:grid lg:grid-cols-[11rem_1fr] lg:gap-6">
            <div className="mb-3 lg:sticky lg:top-28 lg:mb-0 lg:self-start">
              <h2 className="text-xl font-semibold tracking-tight text-gray-900 lg:text-2xl dark:text-white">{g.title}</h2>
              <p className="text-sm text-gray-500">{countFiles(g.items.length)}</p>
              {selecting && (() => {
                const all = g.items.every((f) => selected.has(f.id));
                return <button type="button" onClick={() => onToggleMany(g.items.map((f) => f.id), !all)} className="mt-1 text-sm text-violet-700 hover:underline dark:text-violet-300">{all ? 'Снять месяц' : 'Выбрать месяц'}</button>;
              })()}
            </div>
            {layout === 'smart' ? (
              <SmartRows items={g.items} density={density} render={(f, box) => <Tile key={f.id} file={f} box={box} onOpen={tap} onPick={pick} selecting={selecting} picked={selected.has(f.id)} quick={quick} />} />
            ) : (
              <div className={`grid gap-1 ${GRID[density]}`}>
                {g.items.map((f) => (
                  <Tile key={f.id} file={f} onOpen={tap} onPick={pick} selecting={selecting} picked={selected.has(f.id)} quick={quick} />
                ))}
              </div>
            )}
          </section>
        ))
      )}
      <div ref={sentinel} className="flex h-16 items-center justify-center text-gray-500">
        {loading && <Loader2 className="size-5 animate-spin" aria-label="Загружаем ещё" />}
        {error && !loading && (
          <button type="button" onClick={onMore} className="text-sm text-red-600 underline dark:text-red-400">
            {error} Повторить
          </button>
        )}
      </div>
    </div>
  );
}
