import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronLeft, ChevronRight, Download, FileQuestion, FolderOpen, FolderPlus, Maximize2, Minimize2, ScanFace, Trash2, X, Zap } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent, type WheelEvent } from 'react';
import { api, fileUrl, previewUrl, videoViewUrl } from '../api';
import { formatBytes, formatDateTime } from '../lib/format';
import { isVideo } from '../lib/media';
import { usePref } from '../lib/prefs';
import { NO_ZOOM, clampPan, zoomAt, type View } from '../lib/zoom';
import type { AlbumRef, FileItem, PeopleGroup } from '../types';
import { FaceLayer } from './FaceLayer';
import { AlbumPicker, type PickResult } from './AlbumPicker';

interface Props {
  files: FileItem[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onTrash?: (f: FileItem) => void; // нет у файлов чужого общего альбома
  readOnly?: boolean;
  onAlbumChanged: (f: FileItem, r: PickResult) => void;
  onError: (message: string) => void;
  quick: { id: string; name: string; has: (id: string) => boolean } | null; // «быстрый альбом»
  onQuick: (f: FileItem) => Promise<'added' | 'moved' | null>; // 'moved': Shell уже сам перешёл к соседнему
  people?: { groups: PeopleGroup[]; onChanged: () => void } | null; // есть, когда лица и питомцы включены
}

const FADE = { duration: 0.15 }; // уход старой кнопки 0,15 с + появление новой 0,15 с = плавная замена за 0,3 с

// Кнопка «В альбом»: замена надписи плавная, сама кнопка не перерисовывается, пока ничего не изменилось.
const AlbumButton = memo(function AlbumButton({ name, label, onOpen }: { name: string | null; label: string; onOpen: () => void }) {
  const inAlbum = name !== null;
  return (
    <button type="button" onClick={onOpen} className="flex h-10 items-center justify-center gap-2 rounded-full bg-white/10 px-3.5 text-white transition-colors hover:bg-white/20 sm:w-44" aria-label={inAlbum ? `Альбомы фото (сейчас: ${name})` : 'В альбом'} title={inAlbum ? `Сейчас: ${name}` : 'Добавить в альбом'}>
      {inAlbum ? <FolderOpen className="size-5 shrink-0" aria-hidden /> : <FolderPlus className="size-5 shrink-0" aria-hidden />}
      <span className="hidden min-w-0 flex-1 sm:inline">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span key={label} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={FADE} className="block truncate text-sm">{label}</motion.span>
        </AnimatePresence>
      </span>
    </button>
  );
});

// Быстрая кнопка: «В «Имя»» плавно сменяется надписью «Уже в альбоме». Ширина одна, соседние кнопки не прыгают.
const QuickSlot = memo(function QuickSlot({ name, has, onAdd }: { name: string; has: boolean; onAdd: () => void }) {
  const base = 'flex h-10 items-center justify-center gap-2 rounded-full px-3.5 text-sm font-medium sm:w-44';
  return (
    <AnimatePresence mode="wait" initial={false}>
      {has ? (
        <motion.span key="in" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={FADE} className={`${base} cursor-default bg-white/10 text-white/60`} role="status" title={`Это фото уже в «${name}»`}>
          <Check className="size-5 shrink-0" strokeWidth={3} aria-hidden /><span className="hidden truncate sm:inline">Уже в альбоме</span><span className="sr-only sm:hidden">Уже в альбоме</span>
        </motion.span>
      ) : (
        <motion.button key="add" type="button" onClick={onAdd} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={FADE} aria-label={`Добавить в «${name}»`} title={`Быстро в «${name}» (клавиша A)`} className={`${base} bg-violet-600 text-white hover:bg-violet-500 active:scale-95`}>
          <Zap className="size-5 shrink-0" aria-hidden /><span className="hidden truncate sm:inline">В «{name}»</span>
        </motion.button>
      )}
    </AnimatePresence>
  );
});

const btn = 'flex size-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20';

export function Viewer({ files, index, onIndex, onClose, onTrash, readOnly, onAlbumChanged, onError, quick, onQuick, people }: Props) {
  const file = files[index];
  const cur = useRef(file?.id);
  cur.current = file?.id;
  const busy = useRef(false);
  const [broken, setBroken] = useState(false);
  const [noPreview, setNoPreview] = useState(false); // превью нет или не открылось: показываем оригинал
  const [vfit, setVfit] = usePref<'fit' | 'orig'>('video-size', 'fit', ['fit', 'orig'] as const); // ролик по размеру окна (по умолчанию) или в своём размере
  const [copyReady, setCopyReady] = useState(false); // у ролика, который идёт оригиналом, появилась копия для просмотра
  const touch = useRef<number | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [view, setView] = useState<View>(NO_ZOOM);
  const [dragging, setDragging] = useState(false);
  const [faces, setFaces] = usePref<'on' | 'off'>('faces', 'off', ['on', 'off'] as const); // рамки лиц поверх фото
  const [imgTick, setImgTick] = useState(0);
  // Альбом каждого файла запоминается (и подгружается для соседних фото заранее), поэтому при листании кнопки не мигают.
  const albums = useRef(new Map<string, AlbumRef[]>());
  const [, bump] = useState(0);
  const lastLabel = useRef('В альбом');
  const remember = (id: string, a: AlbumRef[]) => { albums.current.set(id, a); bump((n) => n + 1); };
  const load = (id: string) => { if (!albums.current.has(id)) api.albumOf(id).then((a) => remember(id, a)).catch(() => remember(id, [])); };
  const [picking, setPicking] = useState(false);
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const moved = useRef(false); // последнее нажатие было перетаскиванием, а не кликом

  // Новое фото: масштаб сбрасывается.
  useEffect(() => { setBroken(false); setNoPreview(false); setCopyReady(false); setView(NO_ZOOM); }, [file?.id]);

  // Ролик идёт оригиналом (копии ещё нет): раз в 15 секунд спрашиваем, не готова ли копия. Сервер делает её вне очереди.
  const id = file?.id;
  const isVid = !!file && isVideo(file.mime);
  useEffect(() => {
    if (!id || !isVid || !noPreview || broken || copyReady) return;
    let stop = false;
    const t = setInterval(() => {
      fetch(videoViewUrl(id), { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' })
        .then((r) => { if (!stop && r.ok) setCopyReady(true); })
        .catch(() => undefined);
    }, 15_000);
    return () => { stop = true; clearInterval(t); };
  }, [id, isVid, noPreview, broken, copyReady]);

  // В каком альбоме лежит открытый файл (для подписи кнопки «В альбом» / «Сменить альбом»).
  useEffect(() => {
    if (!file) return;
    setPicking(false);
    load(file.id);
    [files[index - 1], files[index + 1]].forEach((f) => f && load(f.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id]);
  // Известный альбом файла: быстрый альбом знаем сразу, остальное из запомненного; undefined = ещё не узнали.
  const known = file ? albums.current.get(file.id) : undefined;
  const list: AlbumRef[] | undefined = known && file && quick?.has(file.id) && !known.some((a) => a.id === quick.id) ? [...known, { id: quick.id, name: quick.name }] : known ?? (file && quick?.has(file.id) ? [{ id: quick.id, name: quick.name }] : undefined);
  const albumName = list && list.length ? (list.length === 1 ? list[0].name : `${list[0].name} и ещё ${list.length - 1}`) : null;
  const albumLabel = list === undefined ? lastLabel.current : list.length ? 'Альбомы' : 'В альбом';
  lastLabel.current = albumLabel;
  const openPicker = useCallback(() => setPicking(true), []);

  // Одно нажатие: положить в быстрый альбом и открыть следующее фото. Если фото уже там, ничего не делает.
  async function doQuick() {
    if (!file || !quick || busy.current || quick.has(file.id)) return;
    busy.current = true;
    const id = file.id;
    try {
      const r = await onQuick(file);
      if (cur.current !== id || r === null) return;
      remember(id, [...(albums.current.get(id) ?? []).filter((a) => a.id !== quick.id), { id: quick.id, name: quick.name }]);
      if (r === 'added' && index < files.length - 1) onIndex(index + 1);
    } finally {
      busy.current = false;
    }
  }
  const quickRef = useRef(doQuick);
  quickRef.current = doQuick;
  const addQuick = useCallback(() => { void quickRef.current(); }, []);

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
      if (e.code === 'KeyA' && !readOnly && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); void quickRef.current(); }
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
          <p className="truncate text-sm text-white/60">{formatDateTime(file.takenAt)} · {formatBytes(file.size)}{albumName ? ` · ${albumName}` : ''}</p>
        </div>
        {quick && !readOnly && <QuickSlot name={quick.name} has={quick.has(file.id)} onAdd={addQuick} />}
        {!readOnly && <AlbumButton name={albumName} label={albumLabel} onOpen={openPicker} />}
        {people && !video && <button type="button" className={`${btn} ${faces === 'on' ? '!bg-violet-600' : ''}`} onClick={() => setFaces(faces === 'on' ? 'off' : 'on')} aria-pressed={faces === 'on'} aria-label="Показать, кто на фото" title="Кто на фото"><ScanFace className="size-5" aria-hidden /></button>}
        {video && <button type="button" className={btn} onClick={() => setVfit(vfit === 'fit' ? 'orig' : 'fit')} aria-label={vfit === 'fit' ? 'Показать в своём размере' : 'Растянуть по окну'} title={vfit === 'fit' ? 'Показать в своём размере' : 'Растянуть по размеру окна'}>{vfit === 'fit' ? <Minimize2 className="size-5" aria-hidden /> : <Maximize2 className="size-5" aria-hidden />}</button>}
        <a className={btn} href={fileUrl(file.id, true)} download={file.name} aria-label="Скачать" title="Скачать"><Download className="size-5" aria-hidden /></a>
        {onTrash && <button type="button" className={btn} onClick={() => onTrash(file)} aria-label="В корзину" title="В корзину (файл можно восстановить)"><Trash2 className="size-5" aria-hidden /></button>}
      </div>

      <div ref={stage} onClick={onStageClick} onWheel={onWheel} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-2 pb-4 sm:px-16">
        {index > 0 && <button type="button" className={`${btn} absolute left-2 z-10 hidden sm:flex`} onClick={() => onIndex(index - 1)} aria-label="Предыдущий"><ChevronLeft className="size-6" aria-hidden /></button>}
        {index < files.length - 1 && <button type="button" className={`${btn} absolute right-2 z-10 hidden sm:flex`} onClick={() => onIndex(index + 1)} aria-label="Следующий"><ChevronRight className="size-6" aria-hidden /></button>}
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={file.id} initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} className="flex size-full items-center justify-center">
            {video ? (
              <video key={`${file.id}${noPreview ? 'o' : 'v'}`} src={noPreview ? fileUrl(file.id) : videoViewUrl(file.id)} onError={() => (noPreview ? setBroken(true) : setNoPreview(true))}
                onCanPlay={(e) => { if (e.currentTarget.paused && e.currentTarget.currentTime === 0) e.currentTarget.play().catch(() => undefined); }}
                controls autoPlay playsInline preload="auto" className={`rounded-lg bg-black ${vfit === 'fit' ? 'size-full object-contain' : 'max-h-full max-w-full'}`} />
            ) : broken ? (
              <div className="flex flex-col items-center gap-3 text-center text-white/70">
                <FileQuestion className="size-12" aria-hidden />
                <p>Браузер не показывает этот формат.</p>
                <a className="rounded-lg bg-violet-600 px-4 py-2 text-white hover:bg-violet-500" href={fileUrl(file.id, true)} download={file.name}>Скачать файл</a>
              </div>
            ) : (
              <img ref={img} src={noPreview ? fileUrl(file.id) : previewUrl(file.id)} alt={file.name} onError={() => (noPreview ? setBroken(true) : setNoPreview(true))} onLoad={() => setImgTick((n) => n + 1)} draggable={false}
                onClick={onImgClick} onContextMenu={onImgContext} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
                style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transition: dragging ? 'none' : 'transform 90ms ease-out', touchAction: 'none' }}
                className={`max-h-full max-w-full select-none rounded-lg object-contain ${view.scale > 1 ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-pointer'}`} />
            )}
          </motion.div>
        </AnimatePresence>
        {people && faces === 'on' && !video && !broken && <FaceLayer fileId={file.id} img={img} stage={stage} view={view} tick={imgTick} groups={people.groups} onChanged={people.onChanged} onError={onError} />}
        {video && noPreview && !broken && (
          <div role="status" className="absolute inset-x-2 top-2 z-10 mx-auto flex max-w-xl flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-xl bg-black/70 px-3 py-2 text-center text-sm text-white/90 backdrop-blur">
            {copyReady ? (
              <>
                <span>Копия для просмотра готова.</span>
                <button type="button" onClick={(e) => { e.stopPropagation(); setNoPreview(false); setCopyReady(false); }} className="rounded-lg bg-violet-600 px-3 py-1 font-medium text-white hover:bg-violet-500">Переключить</button>
              </>
            ) : (
              <>
                <span>Показан оригинал: копия для просмотра готовится. Если картинки нет, скачайте файл.</span>
                <a href={fileUrl(file.id, true)} download={file.name} onClick={(e) => e.stopPropagation()} className="rounded-lg bg-white/15 px-3 py-1 font-medium hover:bg-white/25">Скачать</a>
              </>
            )}
          </div>
        )}
        <p className="pointer-events-none absolute bottom-2 left-0 right-0 hidden text-center text-xs text-white/40 sm:block">
          {view.scale > 1 ? `${Math.round(view.scale * 100)}%. Клик вернёт масштаб` : 'Клик: дальше. Правый клик: назад. Колесо: масштаб. Клик по фону или Esc: закрыть'}
        </p>
      </div>
      {picking && (
        <AlbumPicker ids={[file.id]} current={list ?? []} onClose={() => setPicking(false)} onError={onError}
          onDone={(r: PickResult) => { setPicking(false); remember(file.id, r.now); onAlbumChanged(file, r); }} />
      )}
    </motion.div>
  );
}
