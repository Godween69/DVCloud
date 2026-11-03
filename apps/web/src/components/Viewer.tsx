import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronLeft, ChevronRight, ChevronsRight, Download, FileQuestion, FolderOpen, FolderPlus, Trash2, X, Zap } from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent, type PointerEvent, type WheelEvent } from 'react';
import { api, fileUrl } from '../api';
import { formatBytes, formatDateTime } from '../lib/format';
import { isVideo } from '../lib/media';
import { usePref } from '../lib/prefs';
import { NO_ZOOM, clampPan, zoomAt, type View } from '../lib/zoom';
import type { AlbumRef, FileItem } from '../types';
import { AlbumPicker } from './AlbumPicker';

interface Props {
  files: FileItem[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onTrash: (f: FileItem) => void;
  onAlbumChanged: (f: FileItem, album: AlbumRef | null, count: number) => void;
  onError: (message: string) => void;
  quick: { id: string; name: string; has: (id: string) => boolean } | null; // «быстрый альбом»
  onQuick: (f: FileItem) => Promise<'added' | 'removed' | 'moved' | null>; // 'moved': Shell уже сам перешёл к соседнему
}

const ADV = ['on', 'off'] as const;
const btn = 'flex size-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20';

export function Viewer({ files, index, onIndex, onClose, onTrash, onAlbumChanged, onError, quick, onQuick }: Props) {
  const file = files[index];
  const [advance, setAdvance] = usePref<'on' | 'off'>('quickAdvance', 'on', ADV);
  const cur = useRef(file?.id);
  cur.current = file?.id;
  const busy = useRef(false);
  const [broken, setBroken] = useState(false);
  const touch = useRef<number | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [view, setView] = useState<View>(NO_ZOOM);
  const [dragging, setDragging] = useState(false);
  const [album, setAlbum] = useState<AlbumRef | null | undefined>(undefined); // undefined = ещё загружается
  const [picking, setPicking] = useState(false);
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const moved = useRef(false); // последнее нажатие было перетаскиванием, а не кликом

  // Новое фото: масштаб сбрасывается.
  useEffect(() => { setBroken(false); setView(NO_ZOOM); }, [file?.id]);

  // В каком альбоме лежит открытый файл (для подписи кнопки «В альбом» / «Сменить альбом»).
  useEffect(() => {
    if (!file) return;
    let alive = true;
    setAlbum(undefined);
    setPicking(false);
    api.albumOf(file.id).then((a) => alive && setAlbum(a)).catch(() => alive && setAlbum(null));
    return () => { alive = false; };
  }, [file?.id]);

  // Одно нажатие: положить в быстрый альбом (или убрать, если уже там) и, если включено, листнуть дальше.
  async function doQuick() {
    if (!file || !quick || busy.current) return;
    busy.current = true;
    const id = file.id;
    try {
      const r = await onQuick(file);
      if (cur.current !== id || r === null) return;
      setAlbum(r === 'removed' ? null : { id: quick.id, name: quick.name });
      if (r === 'added' && advance === 'on' && index < files.length - 1) onIndex(index + 1);
    } finally {
      busy.current = false;
    }
  }
  const quickRef = useRef(doQuick);
  quickRef.current = doQuick;

  const size = () => ({ w: img.current?.offsetWidth ?? 0, h: img.current?.offsetHeight ?? 0 });

  // Колесо: приближение и отдаление к точке под курсором.
  function onWheel(e: WheelEvent) {
    if (!file || isVideo(file.mime)) return;
    const r = stage.current?.getBoundingClientRect();
    if (!r) return;
    const px = e.clientX - (r.left + r.width / 2);
    const py = e.clientY - (r.top + r.height / 2);
    const { w, h } = size();
    setView((v) => clampPan(zoomAt(v, Math.exp(-e.deltaY * 0.002), px, py), w, h));
  }

  // Перетаскивание увеличенного фото левой кнопкой.
  function onPointerDown(e: PointerEvent<HTMLImageElement>) {
    moved.current = false;
    if (e.button !== 0 || view.scale <= 1) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false };
    setDragging(true);
  }
  function onPointerMove(e: PointerEvent<HTMLImageElement>) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 4) moved.current = d.moved = true;
    const { w, h } = size();
    setView((v) => clampPan({ scale: v.scale, x: d.ox + dx, y: d.oy + dy }, w, h));
  }
  function onPointerUp() {
    drag.current = null;
    setDragging(false);
  }

  // Левый клик по фото: следующее (если оно увеличено, то сначала вернуть масштаб). Правый: предыдущее.
  function onImgClick() {
    if (moved.current) return;
    if (view.scale > 1) setView(NO_ZOOM);
    else if (index < files.length - 1) onIndex(index + 1);
  }
  function onImgContext(e: MouseEvent) {
    e.preventDefault();
    if (view.scale > 1) setView(NO_ZOOM);
    else if (index > 0) onIndex(index - 1);
  }

  // Клик по пустому месту за фото закрывает просмотр.
  function onStageClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    if (t.closest('img,video,a,button')) return;
    onClose();
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (picking) return; // пока открыто окно выбора альбома, листать и закрывать просмотр нельзя
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.code === 'KeyA' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); void quickRef.current(); }
      else if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
      else if (e.key === 'ArrowRight' && index < files.length - 1) onIndex(index + 1);
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [index, files.length, onClose, onIndex, picking]);

  if (!file) return null;
  const video = isVideo(file.mime);

  return (
    <motion.div role="dialog" aria-modal="true" aria-label={file.name} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-40 flex flex-col bg-black"
      onTouchStart={(e) => (touch.current = e.touches[0].clientX)}
      onTouchEnd={(e) => {
        if (touch.current === null || video) return;
        const dx = e.changedTouches[0].clientX - touch.current;
        touch.current = null;
        if (dx > 60 && index > 0) onIndex(index - 1);
        else if (dx < -60 && index < files.length - 1) onIndex(index + 1);
      }}>
      <div className="flex items-center gap-3 px-3 py-3 text-white sm:px-5">
        <button type="button" className={btn} onClick={onClose} aria-label="Закрыть"><X className="size-5" aria-hidden /></button>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{file.name}</p>
          <p className="truncate text-sm text-white/60">{formatDateTime(file.takenAt)} · {formatBytes(file.size)}{album ? ` · альбом «${album.name}»` : ''}</p>
        </div>
        {quick && (
          <>
            <button type="button" onClick={() => void doQuick()} aria-pressed={quick.has(file.id)} aria-label={quick.has(file.id) ? `Убрать из «${quick.name}»` : `Добавить в «${quick.name}»`} title={`${quick.has(file.id) ? `Уже в «${quick.name}». Нажмите, чтобы убрать` : `Быстро в «${quick.name}»`} (клавиша A)`}
              className={`flex h-10 max-w-[40vw] items-center gap-2 rounded-full px-3.5 text-sm font-medium text-white transition-all active:scale-95 ${quick.has(file.id) ? 'bg-violet-600 hover:bg-violet-500' : 'bg-white/15 hover:bg-violet-600'}`}>
              {quick.has(file.id) ? <Check className="size-5 shrink-0" strokeWidth={3} aria-hidden /> : <Zap className="size-5 shrink-0" aria-hidden />}
              <span className="hidden truncate sm:inline">В «{quick.name}»</span>
            </button>
            <button type="button" onClick={() => setAdvance(advance === 'on' ? 'off' : 'on')} aria-pressed={advance === 'on'} aria-label="Листать дальше после добавления" title={advance === 'on' ? 'После добавления сразу следующее фото. Нажмите, чтобы выключить' : 'Остаться на этом фото после добавления. Нажмите, чтобы включить листание'} className={`${btn} ${advance === 'on' ? 'bg-violet-600/80 hover:bg-violet-500' : ''}`}><ChevronsRight className="size-5" aria-hidden /></button>
          </>
        )}
        <button type="button" onClick={() => setPicking(true)} disabled={album === undefined} className={`${btn} w-auto max-w-[40vw] gap-2 px-3.5 disabled:opacity-50`} aria-label={album ? `Сменить альбом (сейчас: ${album.name})` : 'В альбом'} title={album ? `Сейчас в альбоме «${album.name}»` : 'Добавить в альбом'}>
          {album ? <FolderOpen className="size-5 shrink-0" aria-hidden /> : <FolderPlus className="size-5 shrink-0" aria-hidden />}
          <span className="hidden truncate text-sm sm:inline">{album ? 'Сменить альбом' : 'В альбом'}</span>
        </button>
        <a className={btn} href={fileUrl(file.id, true)} download={file.name} aria-label="Скачать" title="Скачать"><Download className="size-5" aria-hidden /></a>
        <button type="button" className={btn} onClick={() => onTrash(file)} aria-label="В корзину" title="В корзину"><Trash2 className="size-5" aria-hidden /></button>
      </div>

      <div ref={stage} onClick={onStageClick} onWheel={onWheel} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-2 pb-4 sm:px-16">
        {index > 0 && <button type="button" className={`${btn} absolute left-2 z-10 hidden sm:flex`} onClick={() => onIndex(index - 1)} aria-label="Предыдущий"><ChevronLeft className="size-6" aria-hidden /></button>}
        {index < files.length - 1 && <button type="button" className={`${btn} absolute right-2 z-10 hidden sm:flex`} onClick={() => onIndex(index + 1)} aria-label="Следующий"><ChevronRight className="size-6" aria-hidden /></button>}
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={file.id} initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} className="flex size-full items-center justify-center">
            {video ? (
              <video src={fileUrl(file.id)} controls autoPlay playsInline className="max-h-full max-w-full rounded-lg" />
            ) : broken ? (
              <div className="flex flex-col items-center gap-3 text-center text-white/70">
                <FileQuestion className="size-12" aria-hidden />
                <p>Браузер не показывает этот формат.</p>
                <a className="rounded-lg bg-violet-600 px-4 py-2 text-white hover:bg-violet-500" href={fileUrl(file.id, true)} download={file.name}>Скачать файл</a>
              </div>
            ) : (
              <img ref={img} src={fileUrl(file.id)} alt={file.name} onError={() => setBroken(true)} draggable={false}
                onClick={onImgClick} onContextMenu={onImgContext} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
                style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transition: dragging ? 'none' : 'transform 90ms ease-out', touchAction: 'none' }}
                className={`max-h-full max-w-full select-none rounded-lg object-contain ${view.scale > 1 ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-pointer'}`} />
            )}
          </motion.div>
        </AnimatePresence>
        <p className="pointer-events-none absolute bottom-2 left-0 right-0 hidden text-center text-xs text-white/40 sm:block">
          {view.scale > 1 ? `${Math.round(view.scale * 100)}%. Клик вернёт масштаб` : 'Клик: дальше. Правый клик: назад. Колесо: масштаб. Клик по фону или Esc: закрыть'}
        </p>
      </div>
      {picking && (
        <AlbumPicker ids={[file.id]} current={album ?? null} onClose={() => setPicking(false)} onError={onError}
          onDone={(a, n) => { setPicking(false); setAlbum(a); onAlbumChanged(file, a, n); }} />
      )}
    </motion.div>
  );
}
