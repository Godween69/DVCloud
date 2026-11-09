import { motion } from 'framer-motion';
import { ArrowLeft, Download, Eye, EyeOff, FolderPlus, Folders, Images, Loader2, LogOut, Pencil, Save, Share2, Star, Trash2, Users, Zap } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, thumbUrl } from '../api';
import { albumZipHref } from '../lib/albums';
import { countFiles } from '../lib/format';
import { KIND_LABEL } from '../lib/albumKinds';
import type { Album, AlbumKind, AlbumShow } from '../types';

interface ListProps {
  albums: Album[] | null;
  onOpen: (a: Album) => void;
  onCreated: (a: Album) => void;
  onError: (m: string) => void;
  quickId?: string; // какой альбом сейчас «быстрый»
  onQuick: (a: Album | null) => void; // сделать быстрым или выключить (null)
  filter: AlbumKind | 'all'; // какие альбомы показывать: все или только один тип
  onFilter: (f: AlbumKind | 'all') => void;
  onFavorite: (a: Album) => void; // звёздочка
}

const CHIPS: { key: AlbumKind | 'all'; label: string }[] = [
  { key: 'all', label: 'Все' },
  { key: 'any', label: 'Универсальные' },
  { key: 'screenshots', label: 'Скриншоты' },
  { key: 'photos', label: 'Фото' },
  { key: 'videos', label: 'Видео' },
];

const SHOW_LABELS: { key: keyof AlbumShow; label: string }[] = [
  { key: 'library', label: 'Библиотека' },
  { key: 'photos', label: 'Фото' },
  { key: 'videos', label: 'Видео' },
  { key: 'screenshots', label: 'Скриншоты' },
];
const hiddenIn = (s: AlbumShow): string[] => SHOW_LABELS.filter((x) => !s[x.key]).map((x) => x.label.toLowerCase());

// Где показывать файлы альбома: выключенный раздел не показывает эти файлы в своей ленте, внутри альбома они видны всегда.
function ShowMenu({ album, onChanged, onError }: { album: Album; onChanged: (a: Album) => void; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const hidden = hiddenIn(album.show);
  async function toggle(key: keyof AlbumShow) {
    setBusy(true);
    try {
      onChanged(await api.albumShow(album.id, { [key]: !album.show[key] }));
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Не получилось изменить');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="true" title="В каких разделах показывать фото этого альбома" className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:bg-paper-200 dark:hover:bg-gray-800 ${hidden.length ? 'text-amber-700 dark:text-amber-300' : 'text-gray-700 dark:text-gray-300'}`}>
        {hidden.length ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}<span className="hidden sm:inline">{hidden.length ? 'Скрыт частично' : 'Где виден'}</span>
      </button>
      {open && (
        <div role="group" aria-label="Где показывать альбом" className="glass-strong absolute right-0 top-full z-30 mt-2 w-72 rounded-2xl p-4 shadow-xl">
          <p className="mb-1 text-sm font-semibold text-gray-900 dark:text-white">Где показывать фото альбома</p>
          <p className="mb-3 text-xs text-gray-600 dark:text-gray-400">Выключите раздел, и фото из этого альбома пропадут из него. Внутри самого альбома они видны всегда. Файлы не удаляются.</p>
          <ul className="space-y-1">
            {SHOW_LABELS.map((x) => (
              <li key={x.key}>
                <button type="button" role="switch" aria-checked={album.show[x.key]} disabled={busy} onClick={() => void toggle(x.key)} className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-sm text-gray-800 transition-colors hover:bg-paper-200/70 disabled:opacity-60 dark:text-gray-100 dark:hover:bg-white/5">
                  <span>{x.label}</span>
                  <span className={`relative h-5 w-9 rounded-full transition-colors ${album.show[x.key] ? 'bg-violet-600' : 'bg-gray-300 dark:bg-gray-700'}`}><span className={`absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow transition-transform ${album.show[x.key] ? 'translate-x-4' : ''}`} /></span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// Список альбомов: карточки с обложкой и кнопка «Новый альбом».
export function AlbumsView({ albums, onOpen, onCreated, onError, quickId, onQuick, filter, onFilter, onFavorite }: ListProps) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<AlbumKind>('any');
  const [busy, setBusy] = useState(false);

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

  if (albums === null) return <div className="flex justify-center py-24 text-gray-500"><Loader2 className="size-6 animate-spin" aria-label="Загружаем" /></div>;
  return (
    <div className="mx-auto max-w-[1600px] px-3 pb-24 pt-6 sm:px-6">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h2 className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-white">Альбомы</h2>
        {adding ? (
          <form onSubmit={create} className="flex gap-2">
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setAdding(false)} maxLength={100} placeholder="Название" aria-label="Название альбома" className="w-52 rounded-lg border border-paper-300 bg-white px-3 py-2 text-sm outline-none focus:border-violet-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white" />
            <select value={kind} onChange={(e) => setKind(e.target.value as AlbumKind)} aria-label="Тип альбома" title="Тип выбирается один раз и потом не меняется" className="rounded-lg border border-paper-300 bg-white px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-white">
              {(['any', 'photos', 'videos', 'screenshots'] as const).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
            <button type="submit" disabled={busy || !name.trim()} className="rounded-lg bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-40">Создать</button>
            <button type="button" onClick={() => setAdding(false)} className="rounded-lg px-3 py-2 text-sm text-gray-600 hover:bg-paper-200 dark:text-gray-400 dark:hover:bg-gray-800">Отмена</button>
          </form>
        ) : (
          <button type="button" onClick={() => setAdding(true)} className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-500"><FolderPlus className="size-4" aria-hidden />Новый альбом</button>
        )}
      </div>
      {albums.length > 0 && (
        <div role="group" aria-label="Тип альбомов" className="mb-4 flex flex-wrap gap-2">
          {CHIPS.map((c) => {
            const n = albums.filter((a) => a.mine && (c.key === 'all' || a.kind === c.key)).length;
            return (
              <button key={c.key} type="button" aria-pressed={filter === c.key} onClick={() => onFilter(c.key)} className={`rounded-full px-3 py-1 text-sm font-medium transition-colors ${filter === c.key ? 'bg-violet-600 text-white' : 'bg-paper-200 text-gray-700 hover:bg-paper-300 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'}`}>{c.label}{c.key !== 'all' || n > 0 ? ` (${n})` : ''}</button>
            );
          })}
        </div>
      )}
      {albums.length === 0 ? (
        <div className="mx-auto flex max-w-md flex-col items-center px-4 py-20 text-center">
          <span className="mb-5 flex size-16 items-center justify-center rounded-2xl bg-violet-600/10 text-violet-600 dark:text-violet-400"><Folders className="size-8" aria-hidden /></span>
          <h3 className="text-xl font-semibold text-gray-900 dark:text-white">Альбомов пока нет</h3>
          <p className="mt-2 text-gray-600 dark:text-gray-400">Создайте альбом, затем добавляйте в него фото из просмотра кнопкой «В альбом» или выбирайте сразу много в библиотеке. Одно фото может лежать в нескольких альбомах. Альбомом можно поделиться с другими людьми облака.</p>
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-[repeat(auto-fill,minmax(13rem,16rem))]">
          {albums.filter((a) => filter === 'all' || !a.mine || a.kind === filter).map((a) => {
            const quick = a.id === quickId;
            return (
              <li key={a.id} className="group relative">
                <button type="button" onClick={() => onOpen(a)} aria-label={`${a.name}, ${countFiles(a.count)}`} className={`relative block aspect-[4/5] w-full overflow-hidden rounded-2xl bg-paper-200 text-left ring-1 ring-black/5 transition duration-300 hover:-translate-y-0.5 hover:shadow-[0_0_26px_-4px_rgba(139,92,246,0.5)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:bg-gray-800 dark:ring-white/10 ${quick ? 'ring-2 ring-violet-500 dark:ring-violet-500' : ''}`}>
                  {a.coverFileId ? <img src={thumbUrl(a.coverFileId)} alt="" loading="lazy" className="absolute inset-0 size-full object-cover transition-transform duration-500 group-hover:scale-105" /> : <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-violet-500/20 to-paper-200 text-violet-500/60 dark:to-gray-800"><Images className="size-12" aria-hidden /></div>}
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/35 to-transparent px-3.5 pb-3 pt-14 text-white">
                    <p className="truncate text-base font-semibold drop-shadow">{a.name}</p>
                    <p className="text-sm text-white/80">{countFiles(a.count)}{a.mine && a.kind !== 'any' ? ` · ${KIND_LABEL[a.kind]}` : ''}</p>
                    {!a.mine && <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-white/80"><Users className="size-3.5 shrink-0" aria-hidden />Поделился: {a.ownerName}</p>}
                    {a.mine && hiddenIn(a.show).length > 0 && <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-white/80"><EyeOff className="size-3.5 shrink-0" aria-hidden />Скрыт: {hiddenIn(a.show).join(', ')}</p>}
                    {a.mine && a.sharedWith > 0 && <p className="mt-0.5 flex items-center gap-1 text-xs text-white/80"><Share2 className="size-3.5 shrink-0" aria-hidden />Общий, людей: {a.sharedWith}</p>}
                  </div>
                </button>
                {a.mine && <button type="button" onClick={() => onFavorite(a)} aria-pressed={a.favorite} aria-label={a.favorite ? `Убрать «${a.name}» из избранных` : `Добавить «${a.name}» в избранные`} title={a.favorite ? 'Избранный альбом. Нажмите, чтобы убрать' : 'В избранные: такие альбомы идут первыми'}
                  className={`absolute left-2.5 top-2.5 flex size-8 items-center justify-center rounded-full backdrop-blur transition-all ${a.favorite ? 'bg-black/45 opacity-100' : 'bg-black/45 opacity-0 hover:bg-black/60 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100'}`}>
                  <Star className={`size-4 ${a.favorite ? 'fill-amber-400 text-amber-400' : 'text-white'}`} aria-hidden />
                </button>}
                {a.mine && <button type="button" onClick={() => onQuick(quick ? null : a)} aria-pressed={quick} aria-label={quick ? `Выключить быстрый альбом «${a.name}»` : `Сделать «${a.name}» быстрым альбомом`} title={quick ? 'Быстрый альбом. Нажмите, чтобы выключить' : 'Сделать быстрым: фото будут кладываться сюда одним нажатием'}
                  className={`absolute right-2.5 top-2.5 flex items-center gap-1 rounded-full py-1.5 text-xs font-medium text-white backdrop-blur transition-all ${quick ? 'bg-violet-600 pl-2.5 pr-3 opacity-100' : 'bg-black/45 px-2 opacity-0 hover:bg-violet-600 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100'}`}>
                  <Zap className="size-3.5" aria-hidden />{quick && 'Быстрый'}
                </button>}
              </li>
            );
          })}
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
  isQuick: boolean;
  onQuick: () => void;
  onShare: () => void;
  onSaved: (r: { added: number; skipped: number; quota: boolean }) => void;
  onLeft: () => void;
}

// Шапка открытого альбома: назад, название (можно переименовать), скачать целиком, удалить альбом.
export function AlbumHeader({ album, count, onBack, onRenamed, onDeleted, onError, isQuick, onQuick, onShare, onSaved, onLeft }: HeaderProps) {
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

  async function saveAll() {
    try {
      onSaved(await api.saveAlbum(album.id));
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Не получилось сохранить');
    }
  }
  async function leave() {
    try {
      await api.leave(album.id);
      onLeft();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Не получилось');
    }
  }

  const ghost = 'flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-paper-200 dark:text-gray-300 dark:hover:bg-gray-800';
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-2 px-3 pt-4 sm:px-6">
      <button type="button" onClick={onBack} className={ghost}><ArrowLeft className="size-4" aria-hidden />Альбомы</button>
      {editing && album.mine ? (
        <form onSubmit={rename} className="flex gap-2">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setEditing(false)} maxLength={100} aria-label="Название альбома" className="w-56 rounded-lg border border-paper-300 bg-white px-3 py-1.5 text-lg font-semibold outline-none focus:border-violet-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white" />
          <button type="submit" className="rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500">Сохранить</button>
        </form>
      ) : (
        <h2 className="min-w-0 truncate text-2xl font-semibold tracking-tight text-gray-900 dark:text-white">{album.name}</h2>
      )}
      <span className="text-sm text-gray-500">{countFiles(count)}{!album.mine && album.ownerName ? ` · поделился ${album.ownerName}` : ''}</span>
      {!album.mine ? (
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {count > 0 && <button type="button" onClick={saveAll} className={`${ghost} text-violet-700 dark:text-violet-300`} title="Копии появятся в вашей библиотеке, место на диске почти не тратится"><Save className="size-4" aria-hidden /><span className="hidden sm:inline">Сохранить себе</span></button>}
          {count > 0 && <a href={albumZipHref(album.id)} download className={ghost}><Download className="size-4" aria-hidden /><span className="hidden sm:inline">Скачать альбом</span></a>}
          <button type="button" onClick={leave} className={ghost} title="Альбом исчезнет из вашего списка, у владельца он останется"><LogOut className="size-4" aria-hidden /><span className="hidden sm:inline">Убрать из списка</span></button>
        </div>
      ) : (
      <div className="ml-auto flex flex-wrap items-center gap-1">
        <ShowMenu album={album} onChanged={onRenamed} onError={onError} />
        <button type="button" onClick={onShare} className={ghost}><Share2 className="size-4" aria-hidden /><span className="hidden sm:inline">{album.sharedWith > 0 ? `Общий (${album.sharedWith})` : 'Поделиться'}</span></button>
        <button type="button" onClick={onQuick} aria-pressed={isQuick} title={isQuick ? 'Фото из библиотеки кладутся сюда одним нажатием «+». Нажмите, чтобы выключить' : 'Фото из библиотеки будут кладываться сюда одним нажатием «+»'} className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${isQuick ? 'bg-violet-600 text-white hover:bg-violet-500' : 'text-violet-700 hover:bg-violet-600/10 dark:text-violet-300'}`}><Zap className="size-4" aria-hidden /><span className="hidden sm:inline">{isQuick ? 'Быстрый альбом' : 'Набирать сюда'}</span></button>
        {!editing && <button type="button" onClick={() => setEditing(true)} className={ghost}><Pencil className="size-4" aria-hidden /><span className="hidden sm:inline">Переименовать</span></button>}
        {count > 0 && <a href={albumZipHref(album.id)} download className={ghost}><Download className="size-4" aria-hidden /><span className="hidden sm:inline">Скачать альбом</span></a>}
        <button type="button" onClick={() => (confirm ? remove() : setConfirm(true))} className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium ${confirm ? 'bg-red-600 text-white hover:bg-red-500' : 'text-red-700 hover:bg-red-500/10 dark:text-red-300'}`}>
          <Trash2 className="size-4" aria-hidden />{confirm ? 'Удалить альбом? Фото останутся' : <span className="hidden sm:inline">Удалить альбом</span>}
        </button>
      </div>
      )}
    </motion.div>
  );
}
