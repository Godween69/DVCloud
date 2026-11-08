import { motion } from 'framer-motion';
import { Trash2, Film, Image as ImageIcon, Loader2, RotateCcw, Trash } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ApiError, thumbUrl } from '../api';
import { countFiles, formatBytes, formatDateTime } from '../lib/format';
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

function Thumb({ file }: { file: FileItem }) {
  const [broken, setBroken] = useState(false);
  const video = isVideo(file.mime);
  return (
    <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-paper-200 text-gray-400 dark:bg-gray-800">
      {!broken ? <img src={thumbUrl(file.id)} alt="" loading="lazy" onError={() => setBroken(true)} className="size-full object-cover" /> : video ? <Film className="size-6" aria-hidden /> : <ImageIcon className="size-6" aria-hidden />}
    </div>
  );
}

// Раздел «Корзина»: файлы, которые человек убрал из библиотеки. Они ещё занимают место в квоте, пока их не восстановят или не удалят навсегда.
export function TrashView({ files, loaded, loading, hasMore, error, onMore, onRestored, onPurged, onEmptied, onRestoredMany, onError }: Props) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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
      <ul className="divide-y divide-paper-300 overflow-hidden rounded-xl border border-paper-300 bg-paper-50 dark:divide-gray-800 dark:border-gray-800 dark:bg-gray-900">
        {files.map((f) => (
          <motion.li key={f.id} layout="position" className="flex items-center gap-3 p-3">
            <Thumb file={f} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-gray-900 dark:text-gray-100">{f.name}</p>
              <p className="truncate text-sm text-gray-500">{formatBytes(f.size)}{f.trashedAt ? ` · в корзине с ${formatDateTime(f.trashedAt)}` : ''}</p>
            </div>
            <button type="button" disabled={busy === f.id} onClick={() => act(f.id, async () => { const r = await api.restore(f.id); onRestored(r.file); })} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-violet-700 hover:bg-violet-600/10 dark:text-violet-300">
              <RotateCcw className="size-4" aria-hidden /> <span className="hidden sm:inline">Восстановить</span>
            </button>
            <button type="button" disabled={busy === f.id} onClick={() => (confirm === f.id ? act(f.id, async () => { await api.purge(f.id); onPurged(f.id); }) : setConfirm(f.id))} className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium ${confirm === f.id ? 'bg-red-600 text-white hover:bg-red-500' : 'text-red-700 hover:bg-red-500/10 dark:text-red-300'}`}>
              <Trash className="size-4" aria-hidden /> {confirm === f.id ? 'Точно?' : <span className="hidden sm:inline">Удалить навсегда</span>}
            </button>
          </motion.li>
        ))}
      </ul>
      {hasMore && <button type="button" onClick={onMore} disabled={loading} className="mx-auto mt-6 block text-sm text-violet-700 dark:text-violet-300">{loading ? 'Загружаем…' : 'Показать ещё'}</button>}
      {error && <p role="alert" className="mt-4 text-center text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
