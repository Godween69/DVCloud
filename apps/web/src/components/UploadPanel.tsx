import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, CheckCircle2, Copy, Loader2, X } from 'lucide-react';
import { formatBytes } from '../lib/format';
import type { UploadJob } from '../lib/uploader';

const label: Record<UploadJob['status'], string> = { queued: 'В очереди', uploading: 'Загружается', done: 'Готово', duplicate: 'Уже есть в библиотеке', error: 'Ошибка' };

export function UploadPanel({ jobs, onClear }: { jobs: UploadJob[]; onClear: () => void }) {
  const finished = jobs.filter((j) => j.status === 'done' || j.status === 'duplicate' || j.status === 'error').length;
  const allDone = jobs.length > 0 && finished === jobs.length;
  return (
    <AnimatePresence>
      {jobs.length > 0 && (
        <motion.aside initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 24 }} aria-label="Загрузка файлов" className="fixed bottom-3 right-3 z-30 w-[calc(100vw-1.5rem)] max-w-sm overflow-hidden rounded-xl border border-paper-300 bg-paper-50 shadow-xl dark:border-gray-800 dark:bg-gray-900">
          <div className="flex items-center justify-between border-b border-paper-300 px-4 py-2.5 dark:border-gray-800">
            <p className="text-sm font-medium text-gray-900 dark:text-white">{allDone ? 'Загрузка завершена' : `Загружено ${finished} из ${jobs.length}`}</p>
            {finished > 0 && <button type="button" onClick={onClear} className="flex size-7 items-center justify-center rounded-md text-gray-500 hover:bg-paper-200 dark:hover:bg-gray-800" aria-label="Убрать завершённые"><X className="size-4" aria-hidden /></button>}
          </div>
          <ul className="thin-scroll max-h-64 overflow-y-auto">
            {jobs.map((j) => (
              <li key={j.id} className="flex items-center gap-3 px-4 py-2.5">
                {j.status === 'done' && <CheckCircle2 className="size-5 shrink-0 text-emerald-500" aria-hidden />}
                {j.status === 'duplicate' && <Copy className="size-5 shrink-0 text-gray-400" aria-hidden />}
                {j.status === 'error' && <AlertCircle className="size-5 shrink-0 text-red-500" aria-hidden />}
                {(j.status === 'uploading' || j.status === 'queued') && <Loader2 className={`size-5 shrink-0 text-violet-500 ${j.status === 'uploading' ? 'animate-spin' : 'opacity-40'}`} aria-hidden />}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-gray-900 dark:text-gray-100">{j.name}</p>
                  <p className={`truncate text-xs ${j.status === 'error' ? 'text-red-600 dark:text-red-400' : 'text-gray-500'}`}>{j.status === 'error' ? j.error : `${label[j.status]} · ${formatBytes(j.size)}`}</p>
                  {j.status === 'uploading' && (
                    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-paper-300 dark:bg-gray-800"><div className="h-full rounded-full bg-violet-500 transition-[width]" style={{ width: `${Math.round(j.progress * 100)}%` }} /></div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
