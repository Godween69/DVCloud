import { motion } from 'framer-motion';
import { CalendarDays, Film, ImageOff, Images, LayoutGrid, Loader2, Play, Upload, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { thumbUrl } from '../api';
import { countFiles, formatDateTime } from '../lib/format';
import { groupByMonth } from '../lib/group';
import { isVideo } from '../lib/media';
import { usePref } from '../lib/prefs';
import type { FileItem } from '../types';

type Layout = 'months' | 'wall';
type Density = 's' | 'm' | 'l';
const LAYOUTS = ['months', 'wall'] as const;
const DENSITIES = ['s', 'm', 'l'] as const;

// Размер плиток: на телефоне 4, 3 или 2 в ряд, на широком экране фиксированная сторона плитки.
const GRID: Record<Density, string> = {
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
}

function Tile({ file, onOpen }: { file: FileItem; onOpen: (id: string) => void }) {
  const [broken, setBroken] = useState(false);
  const video = isVideo(file.mime);
  return (
    <button type="button" onClick={() => onOpen(file.id)} aria-label={`Открыть: ${file.name}`} title={`${file.name}, ${formatDateTime(file.takenAt)}`} className="group relative block aspect-square w-full overflow-hidden rounded-md bg-paper-200 [contain-intrinsic-size:8rem] [content-visibility:auto] dark:bg-gray-800">
      {video || broken ? (
        <div className="flex size-full flex-col items-center justify-center gap-2 p-2 text-gray-500 transition-colors group-hover:text-gray-700 dark:text-gray-500 dark:group-hover:text-gray-300">
          {video ? <Film className="size-7" aria-hidden /> : <ImageOff className="size-7" aria-hidden />}
          <span className="line-clamp-2 w-full break-all text-center text-xs">{file.name}</span>
          {video && (
            <span className="absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-full bg-black/50 text-white">
              <Play className="size-3 fill-current" aria-hidden />
            </span>
          )}
        </div>
      ) : (
        <img src={thumbUrl(file.id)} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.04]" />
      )}
    </button>
  );
}

export function Gallery({ files, loaded, loading, hasMore, error, onMore, onOpen, onAdd }: Props) {
  const groups = useMemo(() => groupByMonth(files), [files]);
  const [layout, setLayout] = usePref<Layout>('layout', 'months', LAYOUTS);
  const [density, setDensity] = usePref<Density>('density', 'm', DENSITIES);
  const di = DENSITIES.indexOf(density);
  const sentinel = useRef<HTMLDivElement>(null);

  // Когда нижний край списка показался на экране, подгружаем следующую страницу.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && onMore(), { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, files.length, onMore]);

  if (!loaded) {
    return (
      <div className="mx-auto max-w-[1600px] px-3 py-6 sm:px-6" aria-busy="true" aria-label="Загружаем библиотеку">
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
    <div className="mx-auto max-w-[1600px] px-3 pb-24 pt-4 sm:px-6">
      <div className="sticky top-14 z-10 -mx-3 mb-3 flex items-center justify-end gap-3 bg-paper-100/90 px-3 py-2 backdrop-blur sm:-mx-6 sm:px-6 dark:bg-gray-950/90">
        <div className="flex items-center rounded-lg border border-paper-300 p-0.5 dark:border-gray-800" role="group" aria-label="Размер плиток">
          <button type="button" className={step} disabled={di === 0} onClick={() => setDensity(DENSITIES[di - 1])} aria-label="Мельче" title="Мельче"><ZoomOut className="size-4" aria-hidden /></button>
          <button type="button" className={step} disabled={di === DENSITIES.length - 1} onClick={() => setDensity(DENSITIES[di + 1])} aria-label="Крупнее" title="Крупнее"><ZoomIn className="size-4" aria-hidden /></button>
        </div>
        <div className="flex items-center rounded-lg border border-paper-300 p-0.5 dark:border-gray-800" role="group" aria-label="Режим показа">
          <button type="button" className={seg(layout === 'months')} aria-pressed={layout === 'months'} onClick={() => setLayout('months')}><CalendarDays className="size-4" aria-hidden /><span className="hidden sm:inline">По месяцам</span></button>
          <button type="button" className={seg(layout === 'wall')} aria-pressed={layout === 'wall'} onClick={() => setLayout('wall')}><LayoutGrid className="size-4" aria-hidden /><span className="hidden sm:inline">Сплошная лента</span></button>
        </div>
      </div>
      {layout === 'wall' ? (
        <div className={`grid gap-1 ${GRID[density]}`}>
          {files.map((f) => (
            <Tile key={f.id} file={f} onOpen={onOpen} />
          ))}
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.key} aria-label={g.title} className="mb-8 lg:grid lg:grid-cols-[11rem_1fr] lg:gap-6">
            <div className="mb-3 lg:sticky lg:top-28 lg:mb-0 lg:self-start">
              <h2 className="text-xl font-semibold tracking-tight text-gray-900 lg:text-2xl dark:text-white">{g.title}</h2>
              <p className="text-sm text-gray-500">{countFiles(g.items.length)}</p>
            </div>
            <div className={`grid gap-1 ${GRID[density]}`}>
              {g.items.map((f) => (
                <Tile key={f.id} file={f} onOpen={onOpen} />
              ))}
            </div>
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
