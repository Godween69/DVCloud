import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, Download, FileQuestion, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent, type PointerEvent, type WheelEvent } from 'react';
import { fileUrl } from '../api';
import { formatBytes, formatDateTime } from '../lib/format';
import { isVideo } from '../lib/media';
import { NO_ZOOM, clampPan, zoomAt, type View } from '../lib/zoom';
import type { FileItem } from '../types';

interface Props {
  files: FileItem[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onTrash: (f: FileItem) => void;
}

const btn = 'flex size-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20';

export function Viewer({ files, index, onIndex, onClose, onTrash }: Props) {
  const file = files[index];
  const [broken, setBroken] = useState(false);
  const touch = useRef<number | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [view, setView] = useState<View>(NO_ZOOM);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const moved = useRef(false); // последнее нажатие было перетаскиванием, а не кликом

  // Новое фото: масштаб сбрасывается.
  useEffect(() => { setBroken(false); setView(NO_ZOOM); }, [file?.id]);

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
      if (e.key === 'Escape') onClose();
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
  }, [index, files.length, onClose, onIndex]);

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
          <p className="truncate text-sm text-white/60">{formatDateTime(file.takenAt)} · {formatBytes(file.size)}</p>
        </div>
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
    </motion.div>
  );
}
