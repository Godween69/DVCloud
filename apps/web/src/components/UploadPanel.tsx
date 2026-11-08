import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, CheckCircle2, Copy, Link2, Loader2, RotateCcw, X } from 'lucide-react';
import { countFiles, formatBytes } from '../lib/format';
import { queueStats, type UploadJob } from '../lib/uploader';

const label: Record<UploadJob['status'], string> = {
  queued: 'В очереди',
  checking: 'Проверяется',
  uploading: 'Загружается',
  done: 'Готово',
  linked: 'Уже было в облаке, место не заняло',
  duplicate: 'Уже есть в вашей библиотеке',
  error: 'Ошибка',
};
const SHOWN = 60; // длинный список не рисуем целиком: при тысячах файлов он тормозил бы страницу

export function UploadPanel({ jobs, onClear, onCancel, onRetry }: { jobs: UploadJob[]; onClear: () => void; onCancel: () => void; onRetry: () => void }) {
  const s = queueStats(jobs);
  const allDone = jobs.length > 0 && s.finished === jobs.length;
  const running = jobs.filter((j) => j.status === 'uploading' || j.status === 'checking');
  const failed = jobs.filter((j) => j.status === 'error');
  const queued = jobs.filter((j) => j.status === 'queued');
  const shown = [...running, ...failed, ...queued].slice(0, SHOWN);
  const hidden = running.length + failed.length + queued.length - shown.length;
  const pct = s.bytesTotal ? Math.round((s.bytesDone / s.bytesTotal) * 100) : 0;
  return (
    <AnimatePresence>
      {jobs.length > 0 && (
        <motion.aside initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 24 }} aria-label="Загрузка файлов" className="fixed bottom-3 right-3 z-30 w-[calc(100vw-1.5rem)] max-w-sm overflow-hidden rounded-xl border border-paper-300 bg-paper-50 shadow-xl dark:border-gray-800 dark:bg-gray-900">
          <div className="border-b border-paper-300 px-4 py-2.5 dark:border-gray-800">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-gray-900 dark:text-white" aria-live="polite">{allDone ? (s.failed ? `Готово, не загрузились: ${s.failed}` : 'Загрузка завершена') : `Загружено ${s.finished} из ${s.total}`}</p>
              <div className="flex items-center gap-1">
                {failed.length > 0 && <button type="button" onClick={onRetry} className="flex size-7 items-center justify-center rounded-md text-gray-500 hover:bg-paper-200 dark:hover:bg-gray-800" aria-label="Повторить неудавшиеся" title="Повторить неудавшиеся"><RotateCcw className="size-4" aria-hidden /></button>}
                {s.finished > 0 && <button type="button" onClick={onClear} className="flex size-7 items-center justify-center rounded-md text-gray-500 hover:bg-paper-200 dark:hover:bg-gray-800" aria-label="Убрать завершённые" title="Убрать завершённые"><X className="size-4" aria-hidden /></button>}
              </div>
            </div>
            {s.finished > 0 && (
              <p className="mt-1 text-xs text-gray-500">
                Новых: {jobs.filter((j) => j.status === 'done').length}
                {jobs.some((j) => j.status === 'linked') && ` · уже были в облаке: ${jobs.filter((j) => j.status === 'linked').length}`}
                {jobs.some((j) => j.status === 'duplicate') && ` · уже в вашей библиотеке: ${jobs.filter((j) => j.status === 'duplicate').length}`}
              </p>
            )}
            {!allDone && (
              <>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-paper-300 dark:bg-gray-800"><div className="h-full rounded-full bg-violet-500 transition-[width]" style={{ width: `${pct}%` }} /></div>
                <div className="mt-1 flex items-center justify-between text-xs text-gray-500">
                  <span>{formatBytes(s.bytesDone)} из {formatBytes(s.bytesTotal)}</span>
                  {queued.length > 0 && <button type="button" onClick={onCancel} className="text-violet-600 hover:underline dark:text-violet-400">Отменить ожидающие ({countFiles(queued.length)})</button>}
                </div>
              </>
            )}
          </div>
          <ul className="thin-scroll max-h-64 overflow-y-auto">
            {shown.map((j) => (
              <li key={j.id} className="flex items-center gap-3 px-4 py-2">
                {j.status === 'done' && <CheckCircle2 className="size-5 shrink-0 text-emerald-500" aria-hidden />}
                {j.status === 'linked' && <Link2 className="size-5 shrink-0 text-emerald-500" aria-hidden />}
                {j.status === 'duplicate' && <Copy className="size-5 shrink-0 text-gray-400" aria-hidden />}
                {j.status === 'error' && <AlertCircle className="size-5 shrink-0 text-red-500" aria-hidden />}
                {(j.status === 'uploading' || j.status === 'queued' || j.status === 'checking') && <Loader2 className={`size-5 shrink-0 text-violet-500 ${j.status === 'queued' ? 'opacity-40' : 'animate-spin'}`} aria-hidden />}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-gray-900 dark:text-gray-100" title={j.path}>{j.path}</p>
                  <p className={`truncate text-xs ${j.status === 'error' ? 'text-red-600 dark:text-red-400' : 'text-gray-500'}`}>{j.status === 'error' ? j.error : `${label[j.status]} · ${formatBytes(j.size)}`}</p>
                  {j.status === 'uploading' && (
                    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-paper-300 dark:bg-gray-800"><div className="h-full rounded-full bg-violet-500 transition-[width]" style={{ width: `${Math.round(j.progress * 100)}%` }} /></div>
                  )}
                </div>
              </li>
            ))}
            {hidden > 0 && <li className="px-4 py-2 text-xs text-gray-500">…и ещё {countFiles(hidden)}</li>}
          </ul>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
