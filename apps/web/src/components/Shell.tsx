import { AnimatePresence, motion } from 'framer-motion';
import { Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, sendFile } from '../api';
import { useFeed } from '../lib/useFeed';
import { UploadQueue, type UploadJob } from '../lib/uploader';
import { useTheme } from '../lib/theme';
import type { Usage, User } from '../types';
import { Gallery } from './Gallery';
import { Toast, type ToastData } from './Toast';
import { TopBar, type View } from './TopBar';
import { TrashView } from './TrashView';
import { UploadPanel } from './UploadPanel';
import { Viewer } from './Viewer';

export function Shell({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [theme, toggleTheme] = useTheme();
  const [view, setView] = useState<View>('library');
  const [usage, setUsage] = useState<Usage | null>(null);
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [toast, setToast] = useState<ToastData | null>(null);
  const [viewer, setViewer] = useState<{ id: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const toastId = useRef(0);

  const library = useFeed(false);
  const trash = useFeed(true);

  const refreshUsage = useCallback(() => { api.usage().then(setUsage).catch(() => {}); }, []);
  const say = useCallback((text: string, action?: ToastData['action']) => setToast({ id: ++toastId.current, text, action }), []);
  const doneToast = useCallback(() => setToast(null), []);

  const addLib = library.add;
  const queue = useMemo(
    () => new UploadQueue<File>(sendFile, setJobs, (f, dup) => { if (!dup) addLib(f); refreshUsage(); }),
    [addLib, refreshUsage],
  );

  useEffect(() => { library.loadMore(true); refreshUsage(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => { if (view === 'trash') trash.loadMore(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [view]);

  // Перетаскивание файлов в окно: счётчик нужен, потому что dragenter/leave срабатывают на вложенных элементах.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const enter = (e: DragEvent) => { if (hasFiles(e)) { depth++; setDragging(true); } };
    const leave = (e: DragEvent) => { if (hasFiles(e) && --depth <= 0) { depth = 0; setDragging(false); } };
    const over = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      queue.add(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragenter', enter); window.removeEventListener('dragleave', leave); window.removeEventListener('dragover', over); window.removeEventListener('drop', drop); };
  }, [queue]);

  const openIndex = viewer ? library.files.findIndex((f) => f.id === viewer.id) : -1;
  useEffect(() => { if (viewer && openIndex === -1) setViewer(null); }, [viewer, openIndex]);

  async function toTrash(id: string) {
    const f = library.files.find((x) => x.id === id);
    if (!f) return;
    try {
      await api.trash(id);
    } catch (e) {
      say(e instanceof Error ? e.message : 'Не получилось удалить');
      return;
    }
    // Соседний файл показываем вместо удалённого; если соседей нет, просмотрщик закроется сам.
    const next = library.files[openIndex + 1] ?? library.files[openIndex - 1];
    // Функциональное обновление: если окно просмотра успели закрыть, пока шёл запрос, оно не открывается заново.
    setViewer((v) => (v && v.id === id && next ? { id: next.id } : v));
    library.remove(id);
    say('Файл в корзине', {
      label: 'Вернуть',
      run: () => { api.restore(id).then((r) => { library.add(r.file); refreshUsage(); }).catch(() => say('Не получилось вернуть файл')); },
    });
    refreshUsage();
  }

  async function logout() {
    try { await api.logout(); } catch { /* всё равно уходим на экран входа */ }
    onLogout();
  }

  return (
    <div className="min-h-screen">
      <TopBar user={user} view={view} onView={setView} usage={usage} onAdd={() => input.current?.click()} theme={theme} onToggleTheme={toggleTheme} onLogout={logout} />
      <input ref={input} type="file" multiple accept="image/*,video/*,.heic,.heif" className="hidden" data-testid="file-input" onChange={(e) => { queue.add(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
      <main>
        {view === 'library' ? (
          <Gallery files={library.files} loaded={library.loaded} loading={library.loading} hasMore={library.hasMore} error={library.error} onMore={() => library.loadMore()} onOpen={(id) => setViewer({ id })} onAdd={() => input.current?.click()} />
        ) : (
          <TrashView files={trash.files} loaded={trash.loaded} loading={trash.loading} hasMore={trash.hasMore} error={trash.error} onMore={() => trash.loadMore()}
            onRestored={(f) => { trash.remove(f.id); library.add(f); refreshUsage(); say('Файл возвращён в библиотеку'); }}
            onPurged={(id) => { trash.remove(id); refreshUsage(); say('Файл удалён навсегда'); }} onError={say} />
        )}
      </main>
      <AnimatePresence>
        {viewer && openIndex >= 0 && (
          <Viewer key="viewer" files={library.files} index={openIndex} onIndex={(i) => setViewer({ id: library.files[i].id })} onClose={() => setViewer(null)} onTrash={(f) => toTrash(f.id)} />
        )}
      </AnimatePresence>
      <UploadPanel jobs={jobs} onClear={() => queue.clearFinished()} />
      <Toast toast={toast} onDone={doneToast} />
      <AnimatePresence>
        {dragging && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-violet-600/20 p-6 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-violet-400 bg-gray-950/70 px-12 py-10 text-white">
              <Upload className="size-10" aria-hidden />
              <p className="text-lg font-medium">Отпустите, чтобы загрузить</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
