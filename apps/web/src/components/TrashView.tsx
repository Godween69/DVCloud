import { motion } from 'framer-motion';
import { Film, Image as ImageIcon, Loader2, RotateCcw, Trash, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { formatBytes, formatDateTime } from '../lib/format';
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
  onError: (m: string) => void;
}

export function TrashView({ files, loaded, loading, hasMore, error, onMore, onRestored, onPurged, onError }: Props) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Подтверждение «Удалить навсегда» гаснет само, чтобы не нажать случайно позже.
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(null), 4000);
    return () => clearTimeout(t);
  }, [confirm]);

  async function act(id: string, run: () => Promise<void>) {
    setBusy(id);
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
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Корзина пуста</h2>
        <p className="mt-2 text-gray-600 dark:text-gray-400">Удалённые файлы лежат здесь, пока вы их не вернёте или не удалите навсегда. Место они занимают всё это время.</p>
      </div>
    );

  return (
    <div className="mx-auto max-w-3xl px-3 pb-24 pt-6 sm:px-6">
      <h2 className="mb-1 text-2xl font-semibold tracking-tight text-gray-900 dark:text-white">Корзина</h2>
      <p className="mb-5 text-sm text-gray-600 dark:text-gray-400">Файлы здесь ещё занимают место в вашей квоте.</p>
      <ul className="divide-y divide-paper-300 overflow-hidden rounded-xl border border-paper-300 bg-paper-50 dark:divide-gray-800 dark:border-gray-800 dark:bg-gray-900">
        {files.map((f) => (
          <motion.li key={f.id} layout="position" className="flex items-center gap-3 p-3">
            <div className="flex size-14 shrink-0 items-center justify-center rounded-md bg-paper-200 text-gray-400 dark:bg-gray-800">{isVideo(f.mime) ? <Film className="size-6" aria-hidden /> : <ImageIcon className="size-6" aria-hidden />}</div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-gray-900 dark:text-gray-100">{f.name}</p>
              <p className="truncate text-sm text-gray-500">{formatBytes(f.size)}{f.trashedAt ? ` · удалён ${formatDateTime(f.trashedAt)}` : ''}</p>
            </div>
            <button type="button" disabled={busy === f.id} onClick={() => act(f.id, async () => { const r = await api.restore(f.id); onRestored(r.file); })} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-violet-700 hover:bg-violet-600/10 dark:text-violet-300">
              <RotateCcw className="size-4" aria-hidden /> Вернуть
            </button>
            <button type="button" disabled={busy === f.id} onClick={() => (confirm === f.id ? act(f.id, async () => { await api.purge(f.id); onPurged(f.id); }) : setConfirm(f.id))} className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium ${confirm === f.id ? 'bg-red-600 text-white hover:bg-red-500' : 'text-red-700 hover:bg-red-500/10 dark:text-red-300'}`}>
              <Trash className="size-4" aria-hidden /> {confirm === f.id ? 'Точно удалить?' : 'Удалить навсегда'}
            </button>
          </motion.li>
        ))}
      </ul>
      {hasMore && <button type="button" onClick={onMore} disabled={loading} className="mx-auto mt-6 block text-sm text-violet-700 dark:text-violet-300">{loading ? 'Загружаем…' : 'Показать ещё'}</button>}
      {error && <p role="alert" className="mt-4 text-center text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
