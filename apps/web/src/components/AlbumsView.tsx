import { motion } from 'framer-motion';
import { ArrowLeft, Download, FolderPlus, Folders, Images, Loader2, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, thumbUrl } from '../api';
import { albumZipHref } from '../lib/albums';
import { countFiles } from '../lib/format';
import type { Album } from '../types';

interface ListProps {
  albums: Album[] | null;
  onOpen: (a: Album) => void;
  onCreated: (a: Album) => void;
  onError: (m: string) => void;
}

// Список альбомов: карточки с обложкой и кнопка «Новый альбом».
export function AlbumsView({ albums, onOpen, onCreated, onError }: ListProps) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function create(e: FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    try {
      onCreated(await api.albumCreate(n));
      setName('');
      setAdding(false);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Не получилось создать альбом');
    } finally {
      setBusy(false);
    }
  }

  if (albums === null) return <div className="flex justify-center py-24 text-gray-500"><Loader2 className="size-6 animate-spin" aria-label="Загружаем" /></div>;
  return (
    <div className="mx-auto max-w-[1600px] px-3 pb-24 pt-6 sm:px-6">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h2 className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-white">Альбомы</h2>
        {adding ? (
          <form onSubmit={create} className="flex gap-2">
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setAdding(false)} maxLength={100} placeholder="Название" aria-label="Название альбома" className="w-52 rounded-lg border border-paper-300 bg-white px-3 py-2 text-sm outline-none focus:border-violet-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white" />
            <button type="submit" disabled={busy || !name.trim()} className="rounded-lg bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-40">Создать</button>
            <button type="button" onClick={() => setAdding(false)} className="rounded-lg px-3 py-2 text-sm text-gray-600 hover:bg-paper-200 dark:text-gray-400 dark:hover:bg-gray-800">Отмена</button>
          </form>
        ) : (
          <button type="button" onClick={() => setAdding(true)} className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-500"><FolderPlus className="size-4" aria-hidden />Новый альбом</button>
        )}
      </div>
      {albums.length === 0 ? (
        <div className="mx-auto flex max-w-md flex-col items-center px-4 py-20 text-center">
          <span className="mb-5 flex size-16 items-center justify-center rounded-2xl bg-violet-600/10 text-violet-600 dark:text-violet-400"><Folders className="size-8" aria-hidden /></span>
          <h3 className="text-xl font-semibold text-gray-900 dark:text-white">Альбомов пока нет</h3>
          <p className="mt-2 text-gray-600 dark:text-gray-400">Создайте альбом, затем добавляйте в него фото из просмотра кнопкой «В альбом» или выбирайте сразу много в библиотеке.</p>
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(12rem,15rem))]">
          {albums.map((a) => (
            <li key={a.id}>
              <button type="button" onClick={() => onOpen(a)} className="group block w-full text-left">
                <div className="relative aspect-square overflow-hidden rounded-xl bg-paper-200 dark:bg-gray-800">
                  {a.coverFileId ? <img src={thumbUrl(a.coverFileId)} alt="" loading="lazy" className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.04]" /> : <div className="flex size-full items-center justify-center text-gray-400"><Images className="size-10" aria-hidden /></div>}
                </div>
                <p className="mt-2 truncate font-medium text-gray-900 dark:text-gray-100">{a.name}</p>
                <p className="text-sm text-gray-500">{countFiles(a.count)}</p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface HeaderProps {
  album: Album;
  count: number;
  onBack: () => void;
  onRenamed: (a: Album) => void;
  onDeleted: () => void;
  onError: (m: string) => void;
}

// Шапка открытого альбома: назад, название (можно переименовать), скачать целиком, удалить альбом.
export function AlbumHeader({ album, count, onBack, onRenamed, onDeleted, onError }: HeaderProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(album.name);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => { setName(album.name); setEditing(false); setConfirm(false); }, [album.id, album.name]);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 4000);
    return () => clearTimeout(t);
  }, [confirm]);

  async function rename(e: FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n || n === album.name) { setEditing(false); return; }
    try {
      onRenamed(await api.albumRename(album.id, n));
      setEditing(false);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Не получилось переименовать');
    }
  }
  async function remove() {
    try {
      await api.albumDelete(album.id);
      onDeleted();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Не получилось удалить альбом');
    }
  }

  const ghost = 'flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-paper-200 dark:text-gray-300 dark:hover:bg-gray-800';
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-2 px-3 pt-4 sm:px-6">
      <button type="button" onClick={onBack} className={ghost}><ArrowLeft className="size-4" aria-hidden />Альбомы</button>
      {editing ? (
        <form onSubmit={rename} className="flex gap-2">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setEditing(false)} maxLength={100} aria-label="Название альбома" className="w-56 rounded-lg border border-paper-300 bg-white px-3 py-1.5 text-lg font-semibold outline-none focus:border-violet-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white" />
          <button type="submit" className="rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500">Сохранить</button>
        </form>
      ) : (
        <h2 className="min-w-0 truncate text-2xl font-semibold tracking-tight text-gray-900 dark:text-white">{album.name}</h2>
      )}
      <span className="text-sm text-gray-500">{countFiles(count)}</span>
      <div className="ml-auto flex flex-wrap items-center gap-1">
        {!editing && <button type="button" onClick={() => setEditing(true)} className={ghost}><Pencil className="size-4" aria-hidden /><span className="hidden sm:inline">Переименовать</span></button>}
        {count > 0 && <a href={albumZipHref(album.id)} download className={ghost}><Download className="size-4" aria-hidden /><span className="hidden sm:inline">Скачать альбом</span></a>}
        <button type="button" onClick={() => (confirm ? remove() : setConfirm(true))} className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium ${confirm ? 'bg-red-600 text-white hover:bg-red-500' : 'text-red-700 hover:bg-red-500/10 dark:text-red-300'}`}>
          <Trash2 className="size-4" aria-hidden />{confirm ? 'Удалить альбом? Фото останутся' : <span className="hidden sm:inline">Удалить альбом</span>}
        </button>
      </div>
    </motion.div>
  );
}
