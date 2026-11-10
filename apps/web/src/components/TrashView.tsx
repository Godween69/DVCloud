import { ChevronLeft, ChevronRight, Film, Image as ImageIcon, Loader2, RotateCcw, Trash, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ApiError, previewUrl, thumbUrl } from '../api';
import { countFiles, formatBytes, formatDateTime, groupByDay } from '../lib/format';
import { isVideo } from '../lib/media';
import type { FileItem } from '../types';

interface Props {
  files: FileItem[];
  loaded: boolean;
  loading: boolean;
  hasMore: boolean;
  error: string | null;
  onMore: () => void;
  onRestored: (f: FileItem) => void;
  onPurged: (id: string) => void;
  onEmptied: (removed: number) => void;
  onRestoredMany: () => void;
  onError: (m: string) => void;
}

// Раздел «Корзина»: файлы, которые человек убрал из библиотеки. Они ещё занимают место в квоте, пока их не восстановят или не удалят навсегда.
export function TrashView({ files, loaded, loading, hasMore, error, onMore, onRestored, onPurged, onEmptied, onRestoredMany, onError }: Props) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null); // какой файл открыт для просмотра

  // Подтверждение гаснет само, чтобы не нажать случайно позже.
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(null), 4000);
    return () => clearTimeout(t);
  }, [confirm]);

  async function act(key: string, run: () => Promise<void>) {
    setBusy(key);
    try {
      await run();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Не получилось');
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  }

  if (!loaded) return <div className="flex justify-center py-24 text-gray-500"><Loader2 className="size-6 animate-spin" aria-label="Загружаем" /></div>;
  if (files.length === 0)
    return (
      <div className="mx-auto flex max-w-md flex-col items-center px-4 py-24 text-center">
        <span className="mb-5 flex size-16 items-center justify-center rounded-2xl bg-paper-200 text-gray-500 dark:bg-gray-900"><Trash2 className="size-8" aria-hidden /></span>
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white">В корзине пусто</h2>
        <p className="mt-2 text-gray-600 dark:text-gray-400">Файлы из корзины пропадают из библиотеки, но пока не удалены. Их можно восстановить, пока вы не удалите их навсегда. Место они занимают всё это время.</p>
      </div>
    );

  return (
    <div className="mx-auto max-w-3xl px-3 pb-24 pt-6 sm:px-6">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-2xl font-semibold tracking-tight text-gray-900 dark:text-white">Корзина</h2>
        <button type="button" disabled={busy === 'all'} onClick={() => act('all', async () => { await api.bulk('restore', files.map((f) => f.id)); onRestoredMany(); })} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-violet-700 hover:bg-violet-600/10 dark:text-violet-300">
          <RotateCcw className="size-4" aria-hidden /> Восстановить все{hasMore ? ' показанные' : ''}
        </button>
        <button type="button" disabled={busy === 'empty'} onClick={() => (confirm === 'empty' ? act('empty', async () => onEmptied(await api.emptyTrash())) : setConfirm('empty'))} className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium ${confirm === 'empty' ? 'bg-red-600 text-white hover:bg-red-500' : 'text-red-700 hover:bg-red-500/10 dark:text-red-300'}`}>
          <Trash className="size-4" aria-hidden /> {confirm === 'empty' ? 'Точно удалить всё?' : 'Очистить корзину'}
        </button>
      </div>
      <p className="mb-5 text-sm text-gray-600 dark:text-gray-400">Эти файлы ({countFiles(files.length)}{hasMore ? ' и больше' : ''}) ещё занимают место в вашей квоте. «Удалить навсегда» освобождает его.</p>
      {groupByDay(files).map((g) => (
        <section key={g.key} className="mb-6" aria-label={g.title}>
          <h3 className="mb-2 flex items-baseline gap-2 text-base font-semibold text-gray-900 dark:text-white">{g.title}<span className="text-sm font-normal text-gray-500">{countFiles(g.items.length)}</span></h3>
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
            {g.items.map((f) => (
              <li key={f.id} className="group relative">
                <button type="button" onClick={() => setOpen(f.id)} aria-label={`Посмотреть: ${f.name}`} title={`${f.name} · ${formatBytes(f.size)}${f.trashedAt ? ` · удалён ${formatDateTime(f.trashedAt)}` : ''}`}
                  className="relative block aspect-square w-full overflow-hidden rounded-xl bg-paper-200 ring-1 ring-black/5 transition hover:ring-2 hover:ring-violet-400 focus-visible:outline-2 focus-visible:outline-violet-500 dark:bg-gray-800 dark:ring-white/10">
                  <TrashThumb file={f} />
                  {isVideo(f.mime) && <span className="absolute bottom-1.5 left-1.5 grid size-6 place-items-center rounded-full bg-black/50 text-white"><Film className="size-3.5" aria-hidden /></span>}
                </button>
                <button type="button" disabled={busy === f.id} onClick={() => act(f.id, async () => { const r = await api.restore(f.id); onRestored(r.file); })} aria-label={`Восстановить ${f.name}`} title="Восстановить"
                  className="orb !size-8 right-1.5 top-1.5 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"><RotateCcw className="size-4" aria-hidden /></button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {hasMore && <button type="button" onClick={onMore} disabled={loading} className="mx-auto mt-6 block text-sm text-violet-700 dark:text-violet-300">{loading ? 'Загружаем…' : 'Показать ещё'}</button>}
      {error && <p role="alert" className="mt-4 text-center text-sm text-red-600 dark:text-red-400">{error}</p>}
      {open && <TrashLightbox files={files} id={open} busy={busy} confirm={confirm} onId={setOpen} onClose={() => setOpen(null)}
        onRestore={(f) => act(f.id, async () => { const r = await api.restore(f.id); onRestored(r.file); })}
        onPurge={(f) => (confirm === f.id ? act(f.id, async () => { await api.purge(f.id); onPurged(f.id); }) : setConfirm(f.id))} />}
    </div>
  );
}

function TrashThumb({ file }: { file: FileItem }) {
  const [broken, setBroken] = useState(false);
  return !broken ? <img src={thumbUrl(file.id, true)} alt="" loading="lazy" draggable={false} onError={() => setBroken(true)} className="size-full object-cover" /> : <span className="flex size-full items-center justify-center text-gray-400">{isVideo(file.mime) ? <Film className="size-7" aria-hidden /> : <ImageIcon className="size-7" aria-hidden />}</span>;
}

// Просмотр файла из корзины: крупно, чтобы понять, что это, и решить, восстановить или удалить. Стрелки листают, Esc закрывает.
function TrashLightbox({ files, id, busy, confirm, onId, onClose, onRestore, onPurge }: { files: FileItem[]; id: string; busy: string | null; confirm: string | null; onId: (id: string) => void; onClose: () => void; onRestore: (f: FileItem) => void; onPurge: (f: FileItem) => void }) {
  const i = files.findIndex((f) => f.id === id);
  const f = files[i];
  const [src, setSrc] = useState('preview');
  useEffect(() => { setSrc('preview'); }, [id]);
  useEffect(() => { if (!f) onClose(); }, [f, onClose]); // файл восстановили или удалили: закрываем или идём дальше
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowRight' && i < files.length - 1) onId(files[i + 1].id);
      else if (e.key === 'ArrowLeft' && i > 0) onId(files[i - 1].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [i, files, onId, onClose]);
  if (!f) return null;
  const url = src === 'preview' && !isVideo(f.mime) ? previewUrl(f.id) : thumbUrl(f.id, true);
  const arrow = 'orb top-1/2 -translate-y-1/2';
  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-black/85 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={f.name} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex items-center gap-3 px-4 py-3 text-white">
        <div className="min-w-0 flex-1"><p className="truncate font-medium">{f.name}</p><p className="truncate text-sm text-white/70">{formatBytes(f.size)}{f.trashedAt ? ` · удалён ${formatDateTime(f.trashedAt)}` : ''}</p></div>
        <button type="button" disabled={busy === f.id} onClick={() => onRestore(f)} className="flex items-center gap-1.5 rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500"><RotateCcw className="size-4" aria-hidden />Восстановить</button>
        <button type="button" disabled={busy === f.id} onClick={() => onPurge(f)} className={`flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium ${confirm === f.id ? 'bg-red-600 text-white hover:bg-red-500' : 'bg-white/10 text-white hover:bg-white/20'}`}><Trash className="size-4" aria-hidden />{confirm === f.id ? 'Точно удалить?' : 'Удалить навсегда'}</button>
        <button type="button" onClick={onClose} aria-label="Закрыть" className="grid size-10 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20"><X className="size-5" aria-hidden /></button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <img key={f.id} src={url} alt={f.name} onError={() => setSrc('thumb')} className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" />
        {i > 0 && <button type="button" aria-label="Предыдущий" onClick={() => onId(files[i - 1].id)} className={`${arrow} left-3`}><ChevronLeft className="size-6" aria-hidden /></button>}
        {i < files.length - 1 && <button type="button" aria-label="Следующий" onClick={() => onId(files[i + 1].id)} className={`${arrow} right-3`}><ChevronRight className="size-6" aria-hidden /></button>}
      </div>
    </div>
  );
}
