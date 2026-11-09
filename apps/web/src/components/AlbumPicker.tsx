import { motion } from 'framer-motion';
import { Check, FolderPlus, Loader2, X, Zap, ZapOff } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import type { Album, AlbumRef } from '../types';

interface Props {
  ids: string[]; // что переносим в альбом (один файл из просмотра или выбранные в сетке)
  current: AlbumRef[]; // в каких альбомах файл лежит сейчас (только для одного файла); в режиме target: выбранный быстрый альбом
  onClose: () => void;
  onDone: (r: PickResult) => void;
  onError: (message: string) => void;
  target?: boolean; // выбираем «быстрый альбом»: файлы никуда не кладём, только запоминаем выбор
}

export interface PickResult {
  album: AlbumRef | null;
  n: number;
  removed: boolean; // true: файл убран из album
  now: AlbumRef[]; // в каких альбомах файл теперь (для одного файла)
}

// Окно выбора альбома: «В альбом», а если файл уже лежит в альбоме, «Сменить альбом».
export function AlbumPicker({ ids, current, onClose, onDone, onError, target }: Props) {
  const [albums, setAlbums] = useState<Album[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.albums().then((l) => setAlbums(l.filter((a) => a.mine))).catch((e) => { onError(e instanceof ApiError ? e.message : 'Не удалось загрузить альбомы'); onClose(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const single = !target && ids.length === 1;
  const has = (id: string) => current.some((c) => c.id === id);
  async function run(job: () => Promise<{ album: AlbumRef | null; n: number; removed?: boolean }>) {
    setBusy(true);
    try {
      const r = await job();
      const now = r.album && !r.removed ? [...current.filter((c) => c.id !== r.album!.id), r.album] : current.filter((c) => c.id !== r.album?.id);
      onDone({ album: r.album, n: r.n, removed: r.removed === true, now });
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Не получилось');
      setBusy(false);
    }
  }
  const pick = (a: Album) => run(async () => {
    const ref = { id: a.id, name: a.name };
    if (single && has(a.id)) return { album: ref, n: await api.albumRemoveFiles(a.id, ids), removed: true }; // повторное нажатие убирает фото из альбома
    return { album: ref, n: target ? 0 : await api.albumAdd(a.id, ids) };
  });
  const create = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    run(async () => {
      const a = await api.albumCreate(n);
      return { album: { id: a.id, name: a.name }, n: target ? 0 : await api.albumAdd(a.id, ids) };
    });
  };
  const leave = () => run(async () => ({ album: null, n: 0 }));

  const row = 'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors disabled:opacity-50';
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4" onClick={onClose} onTouchStart={(e) => e.stopPropagation()} onTouchEnd={(e) => e.stopPropagation()}>
      <motion.div role="dialog" aria-modal="true" aria-label={target ? 'Быстрый альбом' : 'В альбом'} initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} onClick={(e) => e.stopPropagation()} className="flex max-h-[80vh] w-full max-w-md flex-col glass-strong rounded-t-3xl text-gray-900 sm:rounded-3xl dark:text-gray-100">
        <div className="flex items-center gap-2 border-b border-paper-300 px-4 py-3 dark:border-gray-800">
          <h2 className="flex-1 text-lg font-semibold">{target ? 'Быстрый альбом' : 'В альбом'}{!target && ids.length > 1 ? ` (${ids.length})` : ''}</h2>
          <button type="button" onClick={onClose} aria-label="Закрыть" className="flex size-8 items-center justify-center rounded-lg text-gray-500 hover:bg-paper-200 dark:hover:bg-gray-800"><X className="size-5" aria-hidden /></button>
        </div>
        {target && <p className="flex items-start gap-2 border-b border-paper-300 bg-violet-600/5 px-4 py-2.5 text-sm text-gray-700 dark:border-gray-800 dark:text-gray-300"><Zap className="mt-0.5 size-4 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden />Выберите альбом один раз. Дальше любое фото кладётся в него одним нажатием на «+».</p>}
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {albums === null ? (
            <div className="flex justify-center py-8 text-gray-500"><Loader2 className="size-5 animate-spin" aria-label="Загружаем" /></div>
          ) : albums.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-gray-600 dark:text-gray-400">Альбомов пока нет. Создайте первый ниже.</p>
          ) : (
            <ul>
              {albums.map((a) => (
                <li key={a.id}>
                  <button type="button" disabled={busy} onClick={() => pick(a)} className={`${row} hover:bg-paper-200 dark:hover:bg-gray-800`}>
                    <span className="min-w-0 flex-1 truncate font-medium">{a.name}</span>
                    {has(a.id) ? <span className="flex items-center gap-1 text-violet-700 dark:text-violet-300"><Check className="size-4" aria-hidden />{target ? 'быстрый' : 'здесь, нажмите чтобы убрать'}</span> : <span className="text-gray-500">{a.count}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {current.length > 0 && target && (
            <button type="button" disabled={busy} onClick={leave} className={`${row} mt-1 text-gray-700 hover:bg-paper-200 dark:text-gray-300 dark:hover:bg-gray-800`}>
              <ZapOff className="size-4" aria-hidden /> Выключить быстрый альбом
            </button>
          )}
        </div>
        <form onSubmit={create} className="flex gap-2 border-t border-paper-300 p-3 dark:border-gray-800">
          <input ref={input} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="Новый альбом" aria-label="Название нового альбома" className="min-w-0 flex-1 rounded-lg border border-paper-300 bg-white px-3 py-2 text-sm outline-none focus:border-violet-500 dark:border-gray-700 dark:bg-gray-950" />
          <button type="submit" disabled={busy || !name.trim()} className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-40">
            <FolderPlus className="size-4" aria-hidden /> Создать
          </button>
        </form>
      </motion.div>
    </div>
  );
}
