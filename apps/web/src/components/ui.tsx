import { AnimatePresence, motion } from 'framer-motion';
import { Info, X } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { HELP, type HelpKey, type HelpTopic } from '../lib/help';

// Фон-«сияние»: два цветных пятна. Цвет задаёт раздел (data-section на <html>), перетекание делает CSS.
export function Aurora({ section }: { section: string }) {
  useEffect(() => {
    document.documentElement.dataset.section = section;
  }, [section]);
  return <div className="aurora" aria-hidden />;
}

// Подсветка под курсором: записывает положение мыши в --mx/--my, дальше всё делает CSS (.glow). Без перерисовок React.
export function trackGlow(e: PointerEvent<HTMLElement>): void {
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`);
  e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`);
}

function HelpBody({ t }: { t: HelpTopic }) {
  return (
    <div className="text-sm leading-relaxed text-gray-700 dark:text-gray-300">
      <p className="text-[15px] font-medium text-gray-900 dark:text-white">{t.lead}</p>
      <ul className="mt-3 space-y-2.5">
        {t.points.map((p) => (
          <li key={p} className="flex gap-2.5"><span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-violet-500" /><span>{p}</span></li>
        ))}
      </ul>
      {t.tip && <p className="mt-4 rounded-xl bg-violet-500/10 px-3.5 py-2.5 text-[13px] text-violet-900 dark:text-violet-200">{t.tip}</p>}
    </div>
  );
}

function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open, close, ref]);
}

// Маленькая «i» рядом с отдельной настройкой: по нажатию всплывает пояснение.
export function InfoDot({ topic, align = 'left' }: { topic: HelpKey; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useDismiss(open, () => setOpen(false), box);
  const t = HELP[topic];
  return (
    <span ref={box} className="relative inline-flex">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={`Справка: ${t.title}`} title="Справка" className="flex size-6 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-violet-500/15 hover:text-violet-600 dark:text-gray-400 dark:hover:text-violet-300">
        <Info className="size-4" aria-hidden />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div role="dialog" aria-label={t.title} initial={{ opacity: 0, y: -6, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.97 }} transition={{ duration: 0.16 }} className={`glass-strong absolute top-full z-40 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-2xl p-4 text-left ${align === 'right' ? 'right-0' : 'left-0'}`}>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{t.title}</p>
            <HelpBody t={t} />
          </motion.div>
        )}
      </AnimatePresence>
    </span>
  );
}

// Справка по текущему разделу: панель, выезжающая справа.
export function HelpSheet({ topic, open, onClose }: { topic: HelpKey; open: boolean; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, onClose, box);
  const t = HELP[topic];
  return (
    <AnimatePresence>
      {open && (
        <motion.div key="help-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} className="fixed inset-0 z-[55] bg-black/30">
          <motion.aside ref={box} role="dialog" aria-modal="true" aria-label={`Справка: ${t.title}`} initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }} transition={{ type: 'spring', stiffness: 420, damping: 38 }} className="glass-strong absolute right-3 top-3 flex max-h-[calc(100vh-1.5rem)] w-[min(26rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-3xl">
            <div className="flex items-center gap-3 border-b border-[var(--glass-line)] px-5 py-4">
              <span className="flex size-9 items-center justify-center rounded-xl bg-violet-600 text-white"><Info className="size-5" aria-hidden /></span>
              <div className="min-w-0 flex-1"><p className="text-xs text-gray-500">Справка</p><h2 className="truncate text-lg font-semibold text-gray-900 dark:text-white">{t.title}</h2></div>
              <button type="button" onClick={onClose} aria-label="Закрыть справку" autoFocus className="flex size-9 items-center justify-center rounded-lg text-gray-500 hover:bg-white/10 hover:text-gray-900 dark:hover:text-white"><X className="size-5" aria-hidden /></button>
            </div>
            <div className="thin-scroll flex-1 overflow-y-auto px-5 py-4"><HelpBody t={t} /></div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// Переключатель «включено / выключено».
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60 ${checked ? 'btn-accent' : 'bg-gray-400/50 dark:bg-white/15'}`}>
      <motion.span layout transition={{ type: 'spring', stiffness: 700, damping: 40 }} className={`absolute top-0.5 size-5 rounded-full bg-white shadow ${checked ? 'right-0.5' : 'left-0.5'}`} />
    </button>
  );
}
