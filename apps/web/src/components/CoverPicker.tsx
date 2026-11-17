import { Check, Images, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ApiError, thumbUrl } from '../api';
import type { Album, FileItem } from '../types';

// Выбор обложки альбома: сетка файлов альбома, клик — выбрать.
// «Автоматически» возвращает обложку «самое свежее фото».
export function CoverPicker({ album, onChanged, onError, onClose }: {
  album: Album;
  onChanged: (a: Album) => void;
  onError: (m: string) => void;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<FileItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api.albumFiles(album.id).then((r) => setFiles(r.files)).catch((e) => onError(e instanceof ApiError ? e.message : 'Не удалось загрузить файлы альбома'));
  }, [album.id]);

  async function pick(fileId: string | null) {
    if (busy !== null) return;
    setBusy(fileId ?? 'auto');
    try {
      onChanged(await api.albumCover(album.id, fileId));
      onClose();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Не удалось поменять обложку');
      setBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Выбор обложки альбома">
      <div className="glass-strong flex max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl p-4 shadow-xl">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-base font-semibold text-gray-900 dark:text-white">Обложка альбома</p>
          <button type="button" onClick={onClose} aria-label="Закрыть" className="grid size-9 place-items-center rounded-full hover:bg-black/5 dark:text-white dark:hover:bg-white/10"><X className="size-5" aria-hidden /></button>
        </div>
        <p className="mb-3 text-xs text-gray-600 dark:text-gray-400">Выберите фото для обложки. Если этот файл уберут из альбома, обложкой снова станет самое свежее фото.</p>
        <button type="button" disabled={busy !== null} onClick={() => void pick(null)} className="mb-3 flex items-center justify-center gap-2 rounded-lg border border-paper-300 bg-white px-3 py-2 text-sm text-gray-700 transition-colors hover:bg-paper-200 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-300 dark:hover:bg-gray-800">
          {busy === 'auto' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Images className="size-4" aria-hidden />}Автоматически: самое свежее фото
        </button>
        <div className="grid flex-1 grid-cols-3 content-start gap-2 overflow-y-auto sm:grid-cols-4 md:grid-cols-5">
          {files === null && <div className="col-span-full flex justify-center py-10"><Loader2 className="size-6 animate-spin text-violet-500" aria-label="Загрузка файлов" /></div>}
          {files !== null && files.length === 0 && <p className="col-span-full py-10 text-center text-sm text-gray-500">В альбоме нет файлов</p>}
          {files !== null && files.map((f) => (
            <div key={f.id} className="aspect-square">
              <button type="button" disabled={busy !== null} onClick={() => void pick(f.id)} aria-label="Сделать обложкой" title="Сделать обложкой"
                className={`relative size-full overflow-hidden rounded-xl ring-1 ring-black/5 transition hover:ring-2 hover:ring-violet-500 disabled:opacity-60 dark:ring-white/10 ${album.coverFileId === f.id ? 'ring-2 ring-violet-500' : ''}`}>
                <img src={thumbUrl(f.id)} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />
                {album.coverFileId === f.id && <span className="absolute right-1 top-1 rounded-full bg-violet-600 p-0.5 text-white"><Check className="size-3.5" aria-hidden /></span>}
                {busy === f.id && <span className="absolute inset-0 grid place-items-center bg-black/40"><Loader2 className="size-5 animate-spin text-white" aria-hidden /></span>}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
