import { motion } from 'framer-motion';
import { CheckCheck, Download, Image as ImageIcon, Smartphone, Trash2, FolderMinus, FolderPlus, UserMinus, X, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { MAX_ZIP_IDS, zipHref } from '../lib/albums';

interface Props {
  ids: string[];
  total: number; // сколько файлов сейчас загружено в сетку
  zipName: string;
  inAlbum: boolean;
  removeLabel?: string; // подпись кнопки «убрать» (в предложенном альбоме иная)
  noTrash?: boolean; // без кнопки «В корзину»
  shared?: boolean; // чужой общий альбом: можно только смотреть и скачать
  onHide?: () => void;
  onAlbum: () => void;
  quickName?: string; // быстрый альбом, если выбран: кнопка кладёт выбранное туда без окна
  onQuick: () => void;
  onRemoveFromAlbum: () => void;
  inPerson?: boolean; // страница человека: можно убрать выбранные фото из группы насовсем
  onRemoveFromPerson?: () => void;
  kinds?: ('screenshot' | 'photo')[]; // какие кнопки смены вида показать
  onKind?: (kind: 'screenshot' | 'photo') => void;
  onAll: () => void;
  onCancel: () => void;
  onTooMany: () => void;
}

const btn = 'flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium transition-colors';
const plain = `${btn} text-gray-800 hover:bg-black/5 disabled:opacity-40 dark:text-gray-100 dark:hover:bg-white/10`; // кнопка без заливки, цвета темы

// Панель внизу экрана, пока включён режим «Выбрать».
export function SelectionBar({ ids, total, zipName, inAlbum, removeLabel, noTrash, shared, onHide, onAlbum, quickName, onQuick, onRemoveFromAlbum, inPerson, onRemoveFromPerson, kinds, onKind, onAll, onCancel, onTooMany }: Props) {
  const [sure, setSure] = useState(false); // «убрать из группы» нельзя отменить, поэтому нужно нажать дважды
  useEffect(() => { if (!sure) return; const t = setTimeout(() => setSure(false), 4000); return () => clearTimeout(t); }, [sure]);
  useEffect(() => { setSure(false); }, [ids.length]);
  const none = ids.length === 0;
  const tooMany = ids.length > MAX_ZIP_IDS;
  const off = 'pointer-events-none opacity-40';
  return (
    <motion.div
      initial={{ y: 24, opacity: 0, scale: 0.96 }} animate={{ y: 0, opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 420, damping: 34 } }}
      exit={{ y: 16, opacity: 0, scale: 0.97, transition: { duration: 0.16, ease: 'easeIn' } }}
      className="pointer-events-none fixed inset-x-0 bottom-20 z-30 flex justify-center px-3 sm:bottom-6">
      <div role="toolbar" aria-label="Действия с выбранным" className="glass glass-bar pointer-events-auto flex max-w-full flex-wrap items-center gap-1 rounded-2xl px-2 py-1.5 text-gray-800 shadow-[0_8px_32px_-8px_rgba(2,6,23,0.45)] dark:text-gray-100">
        <button type="button" onClick={onAll} disabled={ids.length >= total} className={plain}><CheckCheck className="size-4" aria-hidden /><span className="hidden sm:inline">Выбрать всё</span></button>
        {!shared && quickName && <button type="button" onClick={onQuick} disabled={none} className={`${btn} btn-accent text-white disabled:opacity-40`}><Zap className="size-4" aria-hidden /><span className="max-w-[9rem] truncate">В «{quickName}»</span></button>}
        {!shared && <button type="button" onClick={onAlbum} disabled={none} className={plain}><FolderPlus className="size-4" aria-hidden /><span className="hidden sm:inline">{quickName ? 'Другой альбом' : 'В альбом'}</span></button>}
        {!shared && kinds?.map((k) => (
          <button key={k} type="button" onClick={() => onKind?.(k)} disabled={none} className={plain} title={k === 'screenshot' ? 'Пометить выбранные картинки как скриншоты (видео не меняются)' : 'Пометить выбранные картинки как фото (видео не меняются)'}>
            {k === 'screenshot' ? <Smartphone className="size-4" aria-hidden /> : <ImageIcon className="size-4" aria-hidden />}<span className="hidden sm:inline">{k === 'screenshot' ? 'В скриншоты' : 'Это фото'}</span>
          </button>
        ))}
        {inAlbum && !shared && <button type="button" onClick={onRemoveFromAlbum} disabled={none} className={plain}><FolderMinus className="size-4" aria-hidden /><span className="hidden sm:inline">{removeLabel ?? 'Убрать из альбома'}</span></button>}
        {inPerson && !shared && (
          <button type="button" disabled={none} onClick={() => { if (sure) { setSure(false); onRemoveFromPerson?.(); } else setSure(true); }} title="Эти фото больше не попадут в эту группу"
            className={sure ? `${btn} bg-red-600 text-white hover:bg-red-500` : plain}>
            <UserMinus className="size-4" aria-hidden /><span className={sure ? '' : 'hidden sm:inline'}>{sure ? `Точно убрать ${ids.length}?` : 'Убрать из группы'}</span>
          </button>
        )}
        {!shared && !noTrash && <button type="button" onClick={onHide} disabled={none} title="В корзину: файлы можно восстановить" className={plain}><Trash2 className="size-4" aria-hidden /><span className="hidden sm:inline">В корзину</span></button>}
        {tooMany ? (
          <button type="button" onClick={onTooMany} className={plain}><Download className="size-4" aria-hidden /><span className="hidden sm:inline">Скачать ZIP</span></button>
        ) : (
          <a href={none ? undefined : zipHref(ids, zipName)} download aria-disabled={none} className={`${plain} ${none ? off : ''}`}><Download className="size-4" aria-hidden /><span className="hidden sm:inline">Скачать ZIP</span></a>
        )}
        <button type="button" onClick={onCancel} aria-label="Отменить выбор" title="Отменить выбор" className={plain}><X className="size-4" aria-hidden /></button>
      </div>
    </motion.div>
  );
}
