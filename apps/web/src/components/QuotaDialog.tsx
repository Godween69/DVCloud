import { useEffect, useRef } from 'react';
import { countFiles, formatBytes } from '../lib/format';
import type { Estimate } from '../types';

// Окно «не влезет в квоту»: загрузить сколько влезет, попросить место или отменить.
export function QuotaDialog({ est, count, onFit, onAsk, onCancel }: { est: Estimate; count: number; onFit: () => void; onAsk: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onCancel]);
  const lack = Math.max(0, est.needBytes - (est.freeBytes ?? 0));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/60 p-4" role="dialog" aria-modal="true" aria-labelledby="quota-title">
      <div className="glass-strong w-full max-w-md rounded-3xl p-5">
        <h2 id="quota-title" className="text-lg font-semibold text-gray-900 dark:text-white">Не хватает места</h2>
        <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
          Выбрано {countFiles(count)}, это {formatBytes(est.needBytes)}. Свободно {formatBytes(est.freeBytes ?? 0)}, не хватает {formatBytes(lack)}.
        </p>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">Файлы, которые уже есть в облаке, место не занимают, поэтому часть может поместиться.</p>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
          <button ref={ref} type="button" onClick={onFit} className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500">Загрузить, сколько влезет</button>
          <button type="button" onClick={onAsk} className="rounded-lg border border-paper-300 px-4 py-2 text-sm font-medium text-gray-800 hover:bg-paper-200 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800">Попросить больше места</button>
          <button type="button" onClick={onCancel} className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-paper-200 dark:text-gray-400 dark:hover:bg-gray-800">Отмена</button>
        </div>
      </div>
    </div>
  );
}
