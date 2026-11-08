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
    const id = queue.shift() as string;
    if (done.size > LIMIT) done.clear();
    done.add(id);
    active++;
    const img = new Image();
    img.decoding = 'async';
    (img as HTMLImageElement & { fetchPriority?: string }).fetchPriority = 'low';
    const fin = () => { active--; pump(); };
    img.onload = fin;
    img.onerror = fin;
    img.src = thumbUrl(id);
  }
}

// Ставит миниатюры в очередь; прежняя очередь сбрасывается (человек уже листает дальше). Старт после паузы в 600 мс.
export function prefetchThumbs(ids: string[]): void {
  if (saveData() || typeof Image === 'undefined') return;
  queue = ids.filter((id) => !done.has(id));
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
