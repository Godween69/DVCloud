import { AnimatePresence, motion } from 'framer-motion';
import { useEffect } from 'react';

export interface ToastData {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

export function Toast({ toast, onDone }: { toast: ToastData | null; onDone: () => void }) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onDone, toast.action ? 6000 : 4000);
    return () => clearTimeout(t);
  }, [toast, onDone]);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      <AnimatePresence>
        {toast && (
          <motion.div key={toast.id} role="status" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 16 }} className="pointer-events-auto flex items-center gap-4 rounded-xl bg-gray-900 px-4 py-3 text-sm text-white shadow-xl dark:bg-paper-100 dark:text-gray-900">
            <span>{toast.text}</span>
            {toast.action && <button type="button" onClick={() => { toast.action!.run(); onDone(); }} className="font-semibold text-violet-300 hover:text-violet-200 dark:text-violet-700">{toast.action.label}</button>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
