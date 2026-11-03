import { motion } from 'framer-motion';
import { CheckCheck, Download, FolderMinus, FolderPlus, X, Zap } from 'lucide-react';
import { MAX_ZIP_IDS, zipHref } from '../lib/albums';
import { countFiles } from '../lib/format';

interface Props {
  ids: string[];
  total: number; // сколько файлов сейчас загружено в сетку
  zipName: string;
  inAlbum: boolean;
  onAlbum: () => void;
  quickName?: string; // быстрый альбом, если выбран: кнопка кладёт выбранное туда без окна
  onQuick: () => void;
  onRemoveFromAlbum: () => void;
  onAll: () => void;
  onCancel: () => void;
  onTooMany: () => void;
}

const btn = 'flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors';

// Панель внизу экрана, пока включён режим «Выбрать».
export function SelectionBar({ ids, total, zipName, inAlbum, onAlbum, quickName, onQuick, onRemoveFromAlbum, onAll, onCancel, onTooMany }: Props) {
  const none = ids.length === 0;
  const tooMany = ids.length > MAX_ZIP_IDS;
  const off = 'pointer-events-none opacity-40';
  return (
    <motion.div initial={{ y: 80, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 80, opacity: 0 }} className="fixed inset-x-0 bottom-20 z-30 flex justify-center px-3">
      <div role="toolbar" aria-label="Действия с выбранным" className="flex max-w-full flex-wrap items-center gap-1 rounded-2xl bg-gray-900 px-2 py-1.5 text-white shadow-2xl dark:bg-paper-100 dark:text-gray-900">
        <span className="px-3 text-sm font-medium" aria-live="polite">{none ? 'Ничего не выбрано' : `Выбрано: ${countFiles(ids.length)}`}</span>
        <button type="button" onClick={onAll} disabled={ids.length >= total} className={`${btn} hover:bg-white/10 disabled:opacity-40 dark:hover:bg-black/10`}><CheckCheck className="size-4" aria-hidden /><span className="hidden sm:inline">Выбрать всё</span></button>
        {quickName && <button type="button" onClick={onQuick} disabled={none} className={`${btn} bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-40`}><Zap className="size-4" aria-hidden /><span className="max-w-[9rem] truncate">В «{quickName}»</span></button>}
        <button type="button" onClick={onAlbum} disabled={none} className={`${btn} hover:bg-white/10 disabled:opacity-40 dark:hover:bg-black/10`}><FolderPlus className="size-4" aria-hidden /><span className="hidden sm:inline">{quickName ? 'Другой альбом' : 'В альбом'}</span></button>
        {inAlbum && <button type="button" onClick={onRemoveFromAlbum} disabled={none} className={`${btn} hover:bg-white/10 disabled:opacity-40 dark:hover:bg-black/10`}><FolderMinus className="size-4" aria-hidden /><span className="hidden sm:inline">Убрать из альбома</span></button>}
        {tooMany ? (
          <button type="button" onClick={onTooMany} className={`${btn} hover:bg-white/10 dark:hover:bg-black/10`}><Download className="size-4" aria-hidden /><span className="hidden sm:inline">Скачать ZIP</span></button>
        ) : (
          <a href={none ? undefined : zipHref(ids, zipName)} download aria-disabled={none} className={`${btn} hover:bg-white/10 dark:hover:bg-black/10 ${none ? off : ''}`}><Download className="size-4" aria-hidden /><span className="hidden sm:inline">Скачать ZIP</span></a>
        )}
        <button type="button" onClick={onCancel} aria-label="Отменить выбор" title="Отменить выбор" className={`${btn} hover:bg-white/10 dark:hover:bg-black/10`}><X className="size-4" aria-hidden /></button>
      </div>
    </motion.div>
  );
}
