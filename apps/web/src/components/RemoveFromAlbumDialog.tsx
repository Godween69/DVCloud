import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

interface Props {
  albumId: string;
  albumName: string;
  ids: string[];
  onThis: () => void; // убрать только из этого альбома
  onAll: () => void; // убрать из всех альбомов
  onCancel: () => void;
}

// Окно по клавише Del в альбоме. Корзина не затрагивается: файл остаётся в библиотеке.
// Enter: только из этого альбома. Ещё раз Del: из всех альбомов. Esc: отмена.
export function RemoveFromAlbumDialog({ albumId, albumName, ids, onThis, onAll, onCancel }: Props) {
  const [other, setOther] = useState<{ files: number; albums: { id: string; name: string }[] } | null>(null);
  const opened = useRef(Date.now());
  useEffect(() => { api.albumsInOther(albumId, ids).then(setOther).catch(() => setOther({ files: 0, albums: [] })); }, [albumId, ids]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); onCancel(); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) onThis(); }
      else if (e.key === 'Delete') {
        e.preventDefault(); e.stopImmediatePropagation();
        // повтор от зажатой клавиши и слишком быстрый второй удар не считаются
        if (!e.repeat && Date.now() - opened.current > 400) onAll();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onThis, onAll, onCancel]);
  const many = ids.length > 1;
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div role="dialog" aria-modal="true" aria-label="Убрать из альбома" className="glass w-full max-w-md rounded-2xl p-5 text-gray-900 dark:text-white">
        <h3 className="text-lg font-semibold">{many ? `Убрать ${ids.length} файлов из альбома?` : 'Убрать файл из альбома?'}</h3>
        <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">В корзину ничего не попадёт: {many ? 'файлы останутся' : 'файл останется'} в библиотеке.</p>
        <div className="mt-3 min-h-10 text-sm">
          {other === null ? <Loader2 className="size-4 animate-spin" aria-label="Проверяем" /> : other.files === 0
            ? <p className="text-gray-700 dark:text-gray-300">Больше ни в каких альбомах {many ? 'их' : 'его'} нет.</p>
            : <p>{many ? `Ещё в других альбомах: ${other.files} из ${ids.length}` : 'Этот файл есть и в других альбомах'}: {other.albums.map((a) => `«${a.name}»`).join(', ')}.</p>}
        </div>
        <div className="mt-4 flex flex-col gap-2">
          <button type="button" autoFocus onClick={onThis} className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500">Только из «{albumName}» <kbd className="ml-1 rounded bg-white/20 px-1.5 text-xs">Enter</kbd></button>
          <button type="button" onClick={onAll} className="rounded-lg border border-paper-300 bg-white/50 px-4 py-2 text-sm font-medium hover:bg-white/80 dark:border-white/15 dark:bg-white/5 dark:hover:bg-white/10">Из всех альбомов <kbd className="ml-1 rounded bg-black/10 px-1.5 text-xs dark:bg-white/15">Del</kbd></button>
          <button type="button" onClick={onCancel} className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-paper-200 dark:text-gray-400 dark:hover:bg-gray-800">Отмена <kbd className="ml-1 text-xs">Esc</kbd></button>
        </div>
      </div>
    </div>
  );
}
