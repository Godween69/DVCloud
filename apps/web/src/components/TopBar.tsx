import { motion } from 'framer-motion';
import { ChevronDown, Cloud, FilePlus, FolderUp, LogOut, Moon, Search, ShieldCheck, Sun, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatBytes } from '../lib/format';
import type { Theme } from '../lib/theme';
import type { Usage, User } from '../types';

export type View = 'library' | 'photos' | 'videos' | 'screenshots' | 'albums' | 'people' | 'similar' | 'trash' | 'security' | 'search';

interface Props {
  user: User;
  view: View;
  onView: (v: View) => void;
  usage: Usage | null;
  onAdd: () => void;
  onAddFolder: () => void;
  searchOn: boolean; // поиск включён: по смыслу или по именам людей
  peopleOn: boolean; // распознавание лиц или питомцев включено администратором
  theme: Theme;
  onToggleTheme: () => void;
  onLogout: () => void;
}

const iconBtn =
  'flex size-9 items-center justify-center rounded-lg text-gray-600 transition-colors hover:bg-paper-200 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white';

// Одна кнопка «Добавить» с выбором: файлы или целая папка.
function AddMenu({ onAdd, onAddFolder }: { onAdd: () => void; onAddFolder: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const item = 'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-gray-800 transition-colors hover:bg-paper-200 dark:text-gray-100 dark:hover:bg-gray-800';
  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} aria-label="Добавить" className="flex items-center gap-2 rounded-lg bg-violet-600 px-2.5 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-500 sm:px-3.5">
        <Upload className="size-4" aria-hidden />
        <span className="hidden sm:inline">Добавить</span>
        <ChevronDown className={`hidden size-4 transition-transform sm:block ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-30 mt-2 w-60 rounded-xl border border-paper-300 bg-paper-50 p-1.5 shadow-xl dark:border-gray-800 dark:bg-gray-900">
          <button type="button" role="menuitem" autoFocus onClick={() => { setOpen(false); onAdd(); }} className={item}>
            <FilePlus className="size-5 text-violet-600 dark:text-violet-400" aria-hidden />
            <span><span className="block font-medium">Файлы</span><span className="block text-xs text-gray-500">Фото и видео с устройства</span></span>
          </button>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onAddFolder(); }} className={`${item} hidden sm:flex`}>
            <FolderUp className="size-5 text-violet-600 dark:text-violet-400" aria-hidden />
            <span><span className="block font-medium">Папку</span><span className="block text-xs text-gray-500">Вместе с подпапками</span></span>
          </button>
        </div>
      )}
    </div>
  );
}

export function TopBar({ user, view, onView, usage, onAdd, onAddFolder, searchOn, peopleOn, theme, onToggleTheme, onLogout }: Props) {
  const pct = usage && usage.quotaBytes ? Math.min(100, (usage.usedBytes / usage.quotaBytes) * 100) : null;
  const tone = pct === null ? 'bg-violet-500' : pct >= 90 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-violet-500';
  const textTone = pct !== null && pct >= 85 ? 'font-medium text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-gray-400';

  return (
    <header className="sticky top-0 z-20 border-b border-paper-300 bg-paper-100/85 backdrop-blur dark:border-gray-800 dark:bg-gray-950/85">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-3 px-3 sm:px-6">
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-violet-600 text-white">
            <Cloud className="size-4.5" aria-hidden />
          </span>
          <span className="hidden whitespace-nowrap font-semibold tracking-tight text-gray-900 2xl:inline dark:text-white">DV Cloud</span>
        </div>

        <nav aria-label="Разделы" className="ml-1 flex min-w-0 gap-1 overflow-x-auto sm:ml-4">
          {([['library', 'Библиотека'], ['photos', 'Фото'], ['videos', 'Видео'], ['screenshots', 'Скриншоты'], ['albums', 'Альбомы'], ...(peopleOn ? [['people', 'Люди'] as const] : []), ['similar', 'Похожие'], ['trash', 'Корзина']] as const).map(([id, label]) => (
            <button key={id} type="button" onClick={() => onView(id)} aria-current={view === id ? 'page' : undefined} className="relative shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 transition-colors hover:text-gray-900 aria-[current=page]:text-gray-900 dark:text-gray-400 dark:hover:text-white dark:aria-[current=page]:text-white">
              {view === id && <motion.span layoutId="nav-pill" className="absolute inset-0 rounded-lg bg-paper-200 dark:bg-gray-800" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
              <span className="relative">{label}</span>
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-1 sm:gap-3">
          {usage && (
            <div className="hidden w-40 md:block" title="Сколько места занято, включая корзину">
              <div className={`mb-1 text-right text-xs ${textTone}`}>{usage.quotaBytes ? `${formatBytes(usage.usedBytes)} из ${formatBytes(usage.quotaBytes)}` : `${formatBytes(usage.usedBytes)} занято`}</div>
              <div className="h-1.5 overflow-hidden rounded-full bg-paper-300 dark:bg-gray-800" role="progressbar" aria-label="Занятое место" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct === null ? undefined : Math.round(pct)}>
                <motion.div className={`h-full rounded-full ${tone}`} initial={false} animate={{ width: `${pct ?? 100}%` }} transition={{ duration: 0.6, ease: 'easeOut' }} style={pct === null ? { opacity: 0.35 } : undefined} />
              </div>
            </div>
          )}
          {searchOn && (
            <button type="button" onClick={() => onView('search')} aria-current={view === 'search' ? 'page' : undefined} className={`${iconBtn} aria-[current=page]:bg-paper-200 dark:aria-[current=page]:bg-gray-800`} aria-label="Поиск" title="Поиск">
              <Search className="size-5" aria-hidden />
            </button>
          )}
          <AddMenu onAdd={onAdd} onAddFolder={onAddFolder} />
          <button type="button" onClick={() => onView('security')} aria-current={view === 'security' ? 'page' : undefined} className={`${iconBtn} aria-[current=page]:bg-paper-200 dark:aria-[current=page]:bg-gray-800`} aria-label="Безопасность" title="Безопасность">
            <ShieldCheck className="size-5" aria-hidden />
          </button>
          <button type="button" onClick={onToggleTheme} className={iconBtn} aria-label={theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'} title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}>
            {theme === 'dark' ? <Sun className="size-5" aria-hidden /> : <Moon className="size-5" aria-hidden />}
          </button>
          <button type="button" onClick={onLogout} className={iconBtn} aria-label={`Выйти (${user.displayName})`} title={`Выйти (${user.displayName})`}>
            <LogOut className="size-5" aria-hidden />
          </button>
        </div>
      </div>
    </header>
  );
}
