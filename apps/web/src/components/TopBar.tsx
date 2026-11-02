import { motion } from 'framer-motion';
import { Cloud, LogOut, Moon, Sun, Upload } from 'lucide-react';
import { formatBytes } from '../lib/format';
import type { Theme } from '../lib/theme';
import type { Usage, User } from '../types';

export type View = 'library' | 'trash';

interface Props {
  user: User;
  view: View;
  onView: (v: View) => void;
  usage: Usage | null;
  onAdd: () => void;
  theme: Theme;
  onToggleTheme: () => void;
  onLogout: () => void;
}

const iconBtn =
  'flex size-9 items-center justify-center rounded-lg text-gray-600 transition-colors hover:bg-paper-200 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white';

export function TopBar({ user, view, onView, usage, onAdd, theme, onToggleTheme, onLogout }: Props) {
  const pct = usage && usage.quotaBytes ? Math.min(100, (usage.usedBytes / usage.quotaBytes) * 100) : null;
  const tone = pct === null ? 'bg-violet-500' : pct >= 95 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-violet-500';

  return (
    <header className="sticky top-0 z-20 border-b border-paper-300 bg-paper-100/85 backdrop-blur dark:border-gray-800 dark:bg-gray-950/85">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-3 px-3 sm:px-6">
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-violet-600 text-white">
            <Cloud className="size-4.5" aria-hidden />
          </span>
          <span className="hidden font-semibold tracking-tight text-gray-900 sm:inline dark:text-white">DV Cloud</span>
        </div>

        <nav aria-label="Разделы" className="ml-1 flex gap-1 sm:ml-4">
          {([['library', 'Библиотека'], ['trash', 'Корзина']] as const).map(([id, label]) => (
            <button key={id} type="button" onClick={() => onView(id)} aria-current={view === id ? 'page' : undefined} className="relative rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 transition-colors hover:text-gray-900 aria-[current=page]:text-gray-900 dark:text-gray-400 dark:hover:text-white dark:aria-[current=page]:text-white">
              {view === id && <motion.span layoutId="nav-pill" className="absolute inset-0 rounded-lg bg-paper-200 dark:bg-gray-800" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
              <span className="relative">{label}</span>
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-1 sm:gap-3">
          {usage && (
            <div className="hidden w-44 md:block" title="Сколько места занято, включая корзину">
              <div className="mb-1 text-right text-xs text-gray-600 dark:text-gray-400">{usage.quotaBytes ? `${formatBytes(usage.usedBytes)} из ${formatBytes(usage.quotaBytes)}` : `${formatBytes(usage.usedBytes)} занято`}</div>
              <div className="h-1.5 overflow-hidden rounded-full bg-paper-300 dark:bg-gray-800" role="progressbar" aria-label="Занятое место" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct === null ? undefined : Math.round(pct)}>
                <motion.div className={`h-full rounded-full ${tone}`} initial={false} animate={{ width: `${pct ?? 100}%` }} transition={{ duration: 0.6, ease: 'easeOut' }} style={pct === null ? { opacity: 0.35 } : undefined} />
              </div>
            </div>
          )}
          <button type="button" onClick={onAdd} aria-label="Добавить" className="flex items-center gap-2 rounded-lg bg-violet-600 px-2.5 py-2 sm:px-3.5 text-sm font-medium text-white transition-colors hover:bg-violet-500">
            <Upload className="size-4" aria-hidden />
            <span className="hidden sm:inline">Добавить</span>
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
