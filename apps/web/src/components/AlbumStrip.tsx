import { Images, Plus, Star } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, ApiError, thumbUrl } from '../api';
import { stripAlbums } from '../lib/albumKinds';
import type { Album, AlbumKind } from '../types';

interface Props {
  kind: Exclude<AlbumKind, 'any'>;
  albums: Album[] | null;
  onOpen: (a: Album) => void;
  onAll: () => void; // перейти ко всем альбомам этого типа
  onCreated: (a: Album) => void;
  onError: (m: string) => void;
}

// Полоска альбомов над лентой вкладки «Фото», «Видео» или «Скриншоты»: до четырёх своих альбомов этого типа (избранные первыми),
// «Все» и «+ Новый». Нужна, чтобы быстро разложить файлы, не уходя во вкладку «Альбомы».
export function AlbumStrip({ kind, albums, onOpen, onAll, onCreated, onError }: Props) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  if (albums === null) return null;
  const { shown, total } = stripAlbums(albums, kind);

  async function create(e: FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    try {
      onCreated(await api.albumCreate(n, kind));
      setName('');
      setAdding(false);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Не получилось создать альбом');
    } finally {
      setBusy(false);
    }
  }

  const chip = 'flex shrink-0 items-center gap-2 rounded-xl border border-paper-300 bg-white/70 px-2.5 py-1.5 text-sm text-gray-800 transition-colors hover:border-violet-400 hover:bg-white dark:border-gray-800 dark:bg-gray-900/60 dark:text-gray-100 dark:hover:border-violet-500';
  return (
    <nav aria-label="Альбомы этого раздела" className="mx-auto flex max-w-[1600px] items-center gap-2 overflow-x-auto px-3 pt-4 sm:px-6">
      {shown.map((a) => (
        <button key={a.id} type="button" onClick={() => onOpen(a)} className={chip} title={`${a.name}: ${a.count}`}>
          <span className="relative size-8 shrink-0 overflow-hidden rounded-lg bg-paper-200 dark:bg-gray-800">
            {a.coverFileId ? <img src={thumbUrl(a.coverFileId)} alt="" loading="lazy" className="size-full object-cover" /> : <Images className="m-2 size-4 text-violet-500/60" aria-hidden />}
          </span>
          {a.favorite && <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-400" aria-label="Избранный" />}
          <span className="max-w-[10rem] truncate font-medium">{a.name}</span>
          <span className="text-xs text-gray-500">{a.count}</span>
        </button>
      ))}
      {total > 0 && <button type="button" onClick={onAll} className={`${chip} text-violet-700 dark:text-violet-300`}>Все ({total})</button>}
      {adding ? (
        <form onSubmit={create} className="flex shrink-0 gap-1.5">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setAdding(false)} maxLength={100} placeholder="Название" aria-label="Название нового альбома" className="w-40 rounded-lg border border-paper-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-violet-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white" />
          <button type="submit" disabled={busy || !name.trim()} className="rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-40">Создать</button>
        </form>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className={`${chip} text-violet-700 dark:text-violet-300`}><Plus className="size-4" aria-hidden />Новый</button>
      )}
    </nav>
  );
}
