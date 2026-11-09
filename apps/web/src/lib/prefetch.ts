import { thumbUrl } from '../api';

// Фоновая подгрузка миниатюр, которые вот-вот понадобятся (следующие экраны ленты). Тихо, по две за раз, после простоя;
// в режиме экономии трафика не работает. Миниатюры кешируются браузером на год, поэтому потом плитка показывается сразу.
const done = new Set<string>();
let queue: string[] = [];
let active = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
const LIMIT = 400; // сколько адресов помним, чтобы не растить память

function saveData(): boolean {
  const c = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return !!c?.saveData;
}

function pump(): void {
  while (active < 2 && queue.length > 0) {
    const key = queue.shift() as string;
    const fit = key.startsWith('f:');
    const id = fit ? key.slice(2) : key;
    if (done.size > LIMIT) done.clear();
    done.add(key);
    active++;
    const img = new Image();
    img.decoding = 'async';
    (img as HTMLImageElement & { fetchPriority?: string }).fetchPriority = 'low';
    const fin = () => { active--; pump(); };
    img.onload = fin;
    img.onerror = fin;
    img.src = thumbUrl(id, fit);
  }
}

// Ставит миниатюры в очередь; прежняя очередь сбрасывается (человек уже листает дальше). Старт после паузы в 600 мс.
export function prefetchThumbs(ids: string[], fit = false): void {
  if (saveData() || typeof Image === 'undefined') return;
  queue = ids.map((id) => (fit ? `f:${id}` : id)).filter((k) => !done.has(k));
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
    if (idle) idle(pump, { timeout: 2000 }); else pump();
  }, 600);
}

export function cancelPrefetch(): void {
  queue = [];
  if (timer) { clearTimeout(timer); timer = null; }
}
