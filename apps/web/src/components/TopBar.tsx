import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, Cloud, Copy, FilePlus, FolderOpen, FolderUp, Film, Images, Info, LayoutGrid, LogOut, Moon, Search, ShieldCheck, Smartphone, Sun, Trash2, Upload, Users, CloudDownload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatBytes } from '../lib/format';
import type { Theme } from '../lib/theme';
import type { Usage, User } from '../types';

export type View = 'library' | 'photos' | 'videos' | 'screenshots' | 'albums' | 'people' | 'similar' | 'trash' | 'security' | 'search' | 'yandex';

interface Props {
  user: User;
  view: View;
  onView: (v: View) => void;
  usage: Usage | null;
  onAdd: () => void;
  onAddFolder: () => void;
  searchOn: boolean; // поиск включён: по смыслу или по именам людей
  yandexOn: boolean; // помощник входа в Яндекс настроен на сервере
  peopleOn: boolean; // распознавание лиц или питомцев включено администратором
  theme: Theme;
  onToggleTheme: () => void;
  onLogout: () => void;
  onHelp: () => void; // справка по текущему разделу
  hideDock?: boolean; // на телефоне нижняя панель разделов прячется, пока идёт выбор файлов
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
      <button type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} aria-label="Добавить" className="flex items-center gap-2 rounded-xl px-2.5 py-2 text-sm font-medium text-white transition-[filter,transform,box-shadow] hover:brightness-110 active:scale-[0.97] sm:px-3.5" style={{ background: 'linear-gradient(135deg, var(--aur-a), var(--aur-b))', boxShadow: '0 0 14px -2px color-mix(in srgb, var(--aur-a) 60%, transparent)' }}>
        <Upload className="size-4" aria-hidden />
        <span className="hidden sm:inline">Добавить</span>
        <ChevronDown className={`hidden size-4 transition-transform sm:block ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      <AnimatePresence>
      {open && (
        <motion.div role="menu" initial={{ opacity: 0, y: -6, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.97 }} transition={{ duration: 0.15 }} className="glass-strong absolute right-0 top-full z-30 mt-2 w-60 rounded-2xl p-1.5">
          <button type="button" role="menuitem" autoFocus onClick={() => { setOpen(false); onAdd(); }} className={item}>
            <FilePlus className="size-5 text-violet-600 dark:text-violet-400" aria-hidden />
            <span><span className="block font-medium">Файлы</span><span className="block text-xs text-gray-500">Фото и видео с устройства</span></span>
          </button>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onAddFolder(); }} className={`${item} hidden sm:flex`}>
            <FolderUp className="size-5 text-violet-600 dark:text-violet-400" aria-hidden />
            <span><span className="block font-medium">Папку</span><span className="block text-xs text-gray-500">Вместе с подпапками</span></span>
          </button>
        </motion.div>
      )}
      </AnimatePresence>
    </div>
  );
}

// Значки разделов; цвет подсветки берётся у текущего раздела (--aur-a, --aur-b задаёт сайт через data-section).
const NAV_ICON: Record<string, typeof Cloud> = { library: LayoutGrid, photos: Images, videos: Film, screenshots: Smartphone, albums: FolderOpen, people: Users, similar: Copy, trash: Trash2, yandex: CloudDownload };
// Выбранный раздел: ровная «таблетка» без свечения и размытых краёв — сплошной мягкий оттенок цвета раздела и тонкая чёткая рамка.
const LENS = { background: 'color-mix(in srgb, var(--aur-a) 22%, var(--lens-base))', boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--aur-a) 38%, transparent)' };

export function TopBar({ user, view, onView, usage, onAdd, onAddFolder, searchOn, peopleOn, yandexOn, theme, onToggleTheme, onLogout, onHelp, hideDock }: Props) {
  const child = user.isChild === true; // детский режим: только библиотека, фото, видео и альбомы
  const items = child ? ([['library', 'Библиотека'], ['photos', 'Фото'], ['videos', 'Видео'], ['albums', 'Альбомы']] as const) : ([['library', 'Библиотека'], ['photos', 'Фото'], ['videos', 'Видео'], ['screenshots', 'Скриншоты'], ['albums', 'Альбомы'], ...(peopleOn ? [['people', 'Люди'] as const] : []), ['similar', 'Похожие'], ['trash', 'Корзина'], ...(yandexOn ? [['yandex', 'Яндекс Диск'] as const] : [])] as const);
  const pct = usage && usage.quotaBytes ? Math.min(100, (usage.usedBytes / usage.quotaBytes) * 100) : null;
  const tone = pct === null ? 'bg-violet-500' : pct >= 90 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-violet-500';
  const textTone = pct !== null && pct >= 85 ? 'font-medium text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-gray-400';

  return (
    <>
    <header className="glass glass-bar sticky top-0 z-20 rounded-none border-x-0 border-t-0">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-3 px-3 sm:px-6">
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-xl text-white" style={{ background: 'linear-gradient(135deg, var(--aur-a), var(--aur-b))', boxShadow: '0 0 12px -2px color-mix(in srgb, var(--aur-a) 60%, transparent)' }}>
            <Cloud className="size-4.5" aria-hidden />
          </span>
          <span className="hidden whitespace-nowrap font-semibold tracking-tight text-gray-900 2xl:inline dark:text-white">DV Cloud</span>
        </div>

        <nav aria-label="Разделы" className="ml-1 hidden min-w-0 gap-0.5 overflow-x-auto sm:ml-4 sm:flex">
          {items.map(([id, label]) => {
            const Icon = NAV_ICON[id];
            const on = view === id;
            return (
              <button key={id} type="button" onClick={() => onView(id)} aria-current={on ? 'page' : undefined} title={label} className="group relative flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-3.5 py-2 text-sm font-medium text-gray-600 transition-colors hover:text-gray-900 aria-[current=page]:text-gray-900 dark:text-gray-400 dark:hover:text-white dark:aria-[current=page]:text-white">
                {on && <motion.span layoutId="nav-lens" className="absolute inset-0 rounded-full" style={LENS} transition={{ type: 'spring', stiffness: 520, damping: 38 }} />}
                <Icon className="relative size-[22px] transition-transform duration-200 group-hover:scale-110" aria-hidden />
                <span className={`relative ${on ? '' : 'hidden 2xl:inline'}`}>{label}</span>
              </button>
            );
          })}
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
          {searchOn && !child && (
            <button type="button" onClick={() => onView('search')} aria-current={view === 'search' ? 'page' : undefined} className={`${iconBtn} aria-[current=page]:bg-paper-200 dark:aria-[current=page]:bg-gray-800`} aria-label="Поиск" title="Поиск">
              <Search className="size-5" aria-hidden />
            </button>
          )}
          {!child && <AddMenu onAdd={onAdd} onAddFolder={onAddFolder} />}
          {!child && <button type="button" onClick={() => onView('security')} aria-current={view === 'security' ? 'page' : undefined} className={`${iconBtn} aria-[current=page]:bg-paper-200 dark:aria-[current=page]:bg-gray-800`} aria-label="Безопасность" title="Безопасность">
            <ShieldCheck className="size-5" aria-hidden />
          </button>}
          <button type="button" onClick={onHelp} className={iconBtn} aria-label="Справка по разделу" title="Справка по разделу">
            <Info className="size-5" aria-hidden />
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
      {/* Телефон: разделы внизу, как в мобильных приложениях. Активный раздел подсвечен цветом раздела. */}
      {!hideDock && (
        <nav aria-label="Разделы" className="glass glass-bar fixed inset-x-0 bottom-0 z-30 flex gap-0.5 overflow-x-auto rounded-none border-x-0 border-b-0 px-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] pt-1.5 sm:hidden">
          {items.map(([id, label]) => {
            const Icon = NAV_ICON[id];
            const on = view === id;
            return (
              <button key={id} type="button" onClick={() => onView(id)} aria-current={on ? 'page' : undefined} className="relative flex min-w-[4.25rem] flex-1 flex-col items-center gap-0.5 rounded-2xl px-1.5 py-1.5 text-[11px] font-medium text-gray-600 aria-[current=page]:text-gray-900 dark:text-gray-400 dark:aria-[current=page]:text-white">
                {on && <motion.span layoutId="dock-lens" className="absolute inset-0 rounded-full" style={LENS} transition={{ type: 'spring', stiffness: 520, damping: 38 }} />}
                <Icon className="relative size-6" strokeWidth={1.9} aria-hidden />
                <span className="relative whitespace-nowrap">{label}</span>
              </button>
            );
          })}
        </nav>
      )}
    </>
  );
}
