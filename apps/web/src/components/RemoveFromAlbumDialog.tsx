import { FolderMinus, Folders, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

interface Props {
  albumName: string;
  count: number; // сколько файлов убираем
  other: { files: number; albums: { id: string; name: string }[] } | null; // где ещё лежат (null: не удалось узнать)
  onThis: () => void; // только из этого альбома
  onAll: () => void; // из всех альбомов
  onCancel: () => void;
}

// Окно по Del в альбоме, когда файл есть и в других альбомах. Корзина не затрагивается.
// Стрелки переключают вариант, Enter подтверждает, Del ещё раз: из всех альбомов, Esc: отмена.
export function RemoveFromAlbumDialog({ albumName, count, other, onThis, onAll, onCancel }: Props) {
  const [idx, setIdx] = useState(0);
  const opened = useRef(Date.now());
  const actions = [onThis, onAll, onCancel];
  const act = useRef(actions);
  act.current = actions;
  const cur = useRef(0);
  cur.current = idx;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
      if (e.key === 'Escape') { stop(); act.current[2](); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || (e.key === 'Tab' && !e.shiftKey)) { stop(); setIdx((i) => (i + 1) % 3); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey)) { stop(); setIdx((i) => (i + 2) % 3); }
      else if (e.key === 'Enter') { stop(); if (!e.repeat) act.current[cur.current](); }
      else if (e.key === 'Delete') {
        stop();
        // повтор от зажатой клавиши и слишком быстрый второй удар не считаются
        if (!e.repeat && Date.now() - opened.current > 400) act.current[1]();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const many = count > 1;
  const names = other?.albums.map((a) => `«${a.name}»`).join(', ');
  const item = (i: number, icon: ReactNode, title: string, hint: string, key: string, onClick: () => void) => (
    <button type="button" onClick={onClick} onMouseEnter={() => setIdx(i)} aria-current={idx === i}
      className={`group flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors ${idx === i ? 'border-violet-400/70 bg-violet-500/15 shadow-[0_0_24px_-8px_rgba(139,92,246,0.7)]' : 'border-black/5 bg-white/40 hover:bg-white/70 dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10'}`}>
      <span className={`grid size-10 shrink-0 place-items-center rounded-xl ${idx === i ? 'bg-violet-600 text-white' : 'bg-black/5 text-gray-700 dark:bg-white/10 dark:text-gray-200'}`}>{icon}</span>
      <span className="min-w-0 flex-1"><span className="block text-[15px] font-medium text-gray-900 dark:text-white">{title}</span><span className="block text-sm text-gray-600 dark:text-gray-400">{hint}</span></span>
      <kbd className="rounded-md border border-black/10 bg-white/60 px-1.5 py-0.5 text-xs text-gray-700 dark:border-white/15 dark:bg-white/10 dark:text-gray-200">{key}</kbd>
    </button>
  );
  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/45 p-4 backdrop-blur-sm" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div role="dialog" aria-modal="true" aria-label="Убрать из альбома" className="glass-strong w-full max-w-md rounded-3xl p-5 text-gray-900 dark:text-white">
        <h3 className="text-lg font-semibold">{many ? `Убрать ${count} файлов из альбома?` : 'Убрать файл из альбома?'}</h3>
        <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
          {other && other.files > 0 ? (many ? `Ещё в других альбомах: ${other.files} из ${count} (${names}).` : `Файл есть и в других альбомах: ${names}.`) : 'Файлы есть и в других альбомах.'} В корзину ничего не попадёт.
        </p>
        <div className="mt-4 space-y-2">
          {item(0, <FolderMinus className="size-5" aria-hidden />, `Только из «${albumName}»`, 'В других альбомах останется', 'Enter', onThis)}
          {item(1, <Folders className="size-5" aria-hidden />, 'Из всех альбомов', 'Файл останется в библиотеке', 'Del', onAll)}
          {item(2, <X className="size-5" aria-hidden />, 'Отмена', 'Ничего не менять', 'Esc', onCancel)}
        </div>
        <p className="mt-3 text-center text-xs text-gray-500 dark:text-gray-400">Стрелки выбирают вариант, Enter подтверждает</p>
      </div>
    </div>
  );
}
