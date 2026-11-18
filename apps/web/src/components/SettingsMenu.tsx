import { AnimatePresence, motion } from 'framer-motion';
import { ChevronRight, Info, LogOut, Moon, Settings, ShieldCheck, Smartphone, Sun } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Theme } from '../lib/theme';
import type { User } from '../types';
import type { View } from './TopBar';

interface Props {
  user: User;
  view: View;
  onView: (v: View) => void;
  theme: Theme;
  onToggleTheme: () => void;
  onLogout: () => void;
  onHelp: () => void;
}

const iconBtn =
  'flex size-9 items-center justify-center rounded-lg text-gray-600 transition-colors hover:bg-paper-200 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white';
const item =
  'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-gray-800 transition-colors hover:bg-paper-200 dark:text-gray-100 dark:hover:bg-gray-800';

// Шестерёнка: одно меню вместо отдельных кнопок (безопасность, устройства, тема, справка, выход).
export function SettingsMenu({ user, view, onView, theme, onToggleTheme, onLogout, onHelp }: Props) {
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

  const go = (v: View) => { setOpen(false); onView(v); };

  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}
        aria-label="Настройки" title="Настройки"
        className={`${iconBtn} ${open || view === 'security' || view === 'devices' ? 'bg-paper-200 dark:bg-gray-800' : ''}`}>
        <Settings className="size-5" aria-hidden />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div role="menu" initial={{ opacity: 0, y: -6, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }} transition={{ duration: 0.15 }}
            className="glass-strong absolute right-0 top-full z-30 mt-2 w-64 rounded-2xl p-1.5">
            <div className="px-3 py-2.5">
              <p className="truncate text-sm font-semibold text-gray-900 dark:text-white">{user.displayName}</p>
              <p className="truncate text-xs text-gray-500 dark:text-gray-400">@{user.login}</p>
            </div>
            <div className="my-1 h-px bg-paper-300 dark:bg-gray-700" />
            <button type="button" role="menuitem" onClick={() => go('security')} className={item}
              aria-current={view === 'security' ? 'page' : undefined}>
              <ShieldCheck className="size-5 text-violet-600 dark:text-violet-400" aria-hidden />
              <span className="flex-1 font-medium">Безопасность</span>
              <ChevronRight className="size-4 text-gray-400" aria-hidden />
            </button>
            <button type="button" role="menuitem" onClick={() => go('devices')} className={item}
              aria-current={view === 'devices' ? 'page' : undefined}>
              <Smartphone className="size-5 text-violet-600 dark:text-violet-400" aria-hidden />
              <span className="flex-1 font-medium">Устройства</span>
              <ChevronRight className="size-4 text-gray-400" aria-hidden />
            </button>
            <div className="my-1 h-px bg-paper-300 dark:bg-gray-700" />
            <button type="button" role="menuitemcheckbox" aria-checked={theme === 'dark'} onClick={onToggleTheme} className={item}>
              {theme === 'dark' ? <Moon className="size-5 text-violet-600 dark:text-violet-400" aria-hidden /> : <Sun className="size-5 text-violet-600 dark:text-violet-400" aria-hidden />}
              <span className="flex-1 font-medium">Тёмная тема</span>
              <span className={`flex h-5 w-9 items-center rounded-full px-0.5 transition-colors ${theme === 'dark' ? 'bg-violet-600' : 'bg-paper-300 dark:bg-gray-600'}`}>
                <span className={`size-4 rounded-full bg-white transition-transform ${theme === 'dark' ? 'translate-x-4' : ''}`} />
              </span>
            </button>
            <div className="my-1 h-px bg-paper-300 dark:bg-gray-700" />
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onHelp(); }} className={item}>
              <Info className="size-5 text-gray-500 dark:text-gray-400" aria-hidden />
              <span className="font-medium">Справка</span>
            </button>
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onLogout(); }} className={`${item} text-red-600 dark:text-red-400`}>
              <LogOut className="size-5" aria-hidden />
              <span className="font-medium">Выйти</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
