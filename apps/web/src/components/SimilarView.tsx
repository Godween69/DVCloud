import { Check, Loader2, Sparkles, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, previewUrl, thumbUrl } from '../api';
import { formatBytes } from '../lib/format';
import type { SimilarFile, SimilarGroup, SimilarResult } from '../types';

// Серии: кадры одного момента. Дубликатами занимается администратор (с версии 0.11.3 это в админке, в фоне).
const HINT = 'Кадры одного момента, снятые подряд. Лучшие (самые резкие) оставлены, лишние отмечены. Отметки можно менять. Чтобы рассмотреть кадр, зажмите на нём правую кнопку мыши (на телефоне: удерживайте палец): он приблизится, а когда отпустите, улетит обратно.';

interface Zoom { file: SimilarFile; from: DOMRect; open: boolean }

// Приближение кадра: из своей плитки вырастает в большой снимок поверх экрана, отпустили, он возвращается назад.
function ZoomLayer({ z, scale }: { z: Zoom; scale: number }) {
  const vw = window.innerWidth, vh = window.innerHeight;
  const ratio = z.file.width > 0 && z.file.height > 0 ? z.file.width / z.file.height : 1;
  let w = Math.min(vw * 0.94, vh * 0.8 * ratio);
  let h = w / ratio;
  if (h > vh * 0.8) { h = vh * 0.8; w = h * ratio; }
  const [loaded, setLoaded] = useState(false);
  const r = z.from;
  const box = z.open
    ? { left: (vw - w) / 2, top: (vh - h) / 2 - 12, width: w, height: h }
    : { left: r.left, top: r.top, width: r.width, height: r.height };
  return (
    <div className={`pointer-events-none fixed inset-0 z-50 transition-colors duration-200 ${z.open ? 'bg-black/70' : 'bg-black/0'}`} aria-hidden>
      <div className="absolute overflow-hidden rounded-xl shadow-2xl transition-all duration-200 ease-out" style={box}>
        <img src={thumbUrl(z.file.id, true)} alt="" className="absolute inset-0 size-full object-contain" style={{ transform: `scale(${scale})` }} draggable={false} />
        <img src={previewUrl(z.file.id)} alt="" onLoad={() => setLoaded(true)} className={`absolute inset-0 size-full object-contain transition-opacity duration-150 ${loaded ? 'opacity-100' : 'opacity-0'}`} style={{ transform: `scale(${scale})` }} draggable={false} />
      </div>
      {z.open && (
        <p className="absolute inset-x-0 bottom-6 text-center text-sm text-white drop-shadow">
          {z.file.name} · {z.file.width}×{z.file.height} · {formatBytes(z.file.size)}
        </p>
      )}
    </div>
  );
}

// Экран «Похожие»: группы снимков, предложение что убрать, удаление в корзину (с возможностью вернуть).
export function SimilarView({ onTrashed, onError }: { onTrashed: (ids: string[]) => void; onError: (m: string) => void }) {
  const kind = 'series' as const;
  const [data, setData] = useState<SimilarResult | null>(null);
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState<Zoom | null>(null);
  const [scale, setScale] = useState(1);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noClick = useRef(0); // после приближения пальцем отпускание не должно отметить кадр

  const load = useCallback((k: 'series') => {
    setData(null);
    api.similar(k).then((r) => {
      setData(r);
      setMarked(new Set(r.groups.flatMap((g) => g.files.filter((f) => f.suggestRemove).map((f) => f.id))));
    }).catch((e) => onError(e instanceof ApiError ? e.message : 'Не удалось загрузить'));
  }, [onError]);
  useEffect(() => { load(kind); }, [kind, load]);

  function openZoom(file: SimilarFile, el: HTMLElement) {
    setScale(1);
    setZoom({ file, from: el.getBoundingClientRect(), open: false });
    requestAnimationFrame(() => requestAnimationFrame(() => setZoom((z) => (z && z.file.id === file.id ? { ...z, open: true } : z))));
  }
  function closeZoom() {
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
    setZoom((z) => (z ? { ...z, open: false } : z));
    window.setTimeout(() => setZoom((z) => (z && !z.open ? null : z)), 230);
  }
  // Заранее просим у сервера большое изображение, чтобы к нажатию оно уже было готово.
  function preload(id: string) { const i = new Image(); i.src = previewUrl(id); }
  useEffect(() => {
    if (!zoom) return;
    const onWheel = (e: WheelEvent) => { e.preventDefault(); setScale((s) => Math.min(4, Math.max(1, s - e.deltaY * 0.002))); };
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('pointerup', closeZoom);
    window.addEventListener('pointercancel', closeZoom);
    return () => { window.removeEventListener('wheel', onWheel); window.removeEventListener('pointerup', closeZoom); window.removeEventListener('pointercancel', closeZoom); };
  }, [zoom?.file.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = marked.size;
  const bytes = useMemo(() => (data?.groups ?? []).flatMap((g) => g.files).filter((f) => marked.has(f.id)).reduce((s, f) => s + f.size, 0), [data, marked]);

  function toggle(id: string) {
    if (Date.now() < noClick.current) return;
    setMarked((m) => { const n = new Set(m); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  async function trashMarked() {
    if (!data || busy) return;
    setBusy(true);
    const done: string[] = [];
    // В группе всегда остаётся хотя бы один снимок: если отмечены все, последний не трогаем.
    const groups = data.groups.map((g) => ({ g, ids: g.files.filter((f) => marked.has(f.id)).map((f) => f.id) })).map(({ g, ids }) => ({ g, ids: ids.length === g.files.length ? ids.slice(1) : ids }));
    try {
      for (const { ids } of groups) for (const id of ids) { await api.trash(id); done.push(id); }
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Не получилось удалить');
    } finally {
      setBusy(false);
    }
    if (done.length) { onTrashed(done); load(kind); }
  }

  const progress = data && data.ready < data.images;
  return (
    <div className="mx-auto max-w-4xl px-3 pb-32 pt-6 sm:px-6">
      <h2 className="mb-1 text-2xl font-semibold tracking-tight text-gray-900 dark:text-white">Серии</h2>
      <p className="mb-5 text-sm text-gray-600 dark:text-gray-400">{HINT}</p>
      {progress && <p className="mb-4 flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300"><Sparkles className="size-4" aria-hidden /> Идёт подготовка: обработано {data!.ready} из {data!.images} фото. Результат будет полнее.</p>}
      {!data && <div className="flex justify-center py-20 text-gray-500"><Loader2 className="size-6 animate-spin" aria-label="Загружаем" /></div>}
      {data && data.groups.length === 0 && <p className="py-16 text-center text-gray-600 dark:text-gray-400">{'Серий не найдено.'}</p>}
      <ul className="space-y-4">
        {data?.groups.map((g: SimilarGroup) => (
          <li key={g.id} className="glass rounded-xl p-3">
            <ul className="flex gap-3 overflow-x-auto pb-1">
              {g.files.map((f, i) => (
                <li key={f.id} className="w-36 shrink-0">
                  <button type="button" onClick={() => toggle(f.id)}
                    onPointerEnter={() => preload(f.id)}
                    onContextMenu={(e) => e.preventDefault()}
                    onPointerDown={(e) => {
                      const el = e.currentTarget;
                      if (e.pointerType === 'mouse') { if (e.button === 2) { e.preventDefault(); openZoom(f, el); } return; }
                      // палец: удержание около полсекунды приближает кадр
                      holdTimer.current = setTimeout(() => { noClick.current = Date.now() + 600; openZoom(f, el); }, 380);
                    }}
                    onPointerUp={() => { if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; } }}
                    onPointerCancel={() => { if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; } }}
                    aria-pressed={marked.has(f.id)} aria-label={`${f.name}: ${marked.has(f.id) ? 'будет удалён' : 'останется'}`} className={`relative block overflow-hidden rounded-lg ring-2 ${marked.has(f.id) ? 'ring-red-500' : 'ring-transparent'}`}>
                    <img src={thumbUrl(f.id)} alt="" loading="lazy" className={`aspect-square w-full object-cover ${marked.has(f.id) ? 'opacity-50' : ''}`} />
                    <span className={`absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-full text-white ${marked.has(f.id) ? 'bg-red-600' : 'bg-emerald-600'}`}>{marked.has(f.id) ? <Trash2 className="size-3.5" aria-hidden /> : <Check className="size-3.5" aria-hidden />}</span>
                    {i === 0 && <span className="absolute bottom-1.5 left-1.5 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">лучший</span>}
                  </button>
                  <p className="mt-1 truncate text-xs text-gray-700 dark:text-gray-300">{f.name}</p>
                  <p className="text-xs text-gray-500">{f.width}×{f.height} · {formatBytes(f.size)}</p>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {zoom && <ZoomLayer z={zoom} scale={scale} />}
      {total > 0 && (
        <div className="fixed inset-x-0 bottom-[3.75rem] z-30 sm:bottom-0 border-t border-paper-300 bg-paper-100/95 p-3 dark:border-gray-800 dark:bg-gray-950/95">
          <div className="mx-auto flex max-w-4xl items-center justify-between gap-3">
            <span className="text-sm text-gray-700 dark:text-gray-300">Отмечено: {total} ({formatBytes(bytes)}). Файлы уйдут в корзину, их можно вернуть.</span>
            <button type="button" disabled={busy} onClick={trashMarked} className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-60">
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Trash2 className="size-4" aria-hidden />} В корзину
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
