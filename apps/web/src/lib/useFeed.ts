import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type { FileItem } from '../types';
import { insertSorted } from './group';

// Список файлов с подгрузкой страницами. trashed=true даёт корзину, albumId даёт файлы одного альбома.
export function useFeed(trashed: boolean, albumId?: string, kind?: 'library' | 'photos' | 'videos' | 'screenshots', person?: string) {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const cursor = useRef<string | null>(null);
  const done = useRef(false); // последняя страница уже получена
  const gen = useRef(0); // номер запуска: ответ устаревшего запуска (другой альбом) отбрасывается
  const prevRef = useRef<string | null>(null); // ключ для догрузки к новым (после перехода к месяцу), null: выше ничего нет
  const newerBusy = useRef(false);
  const [hasNewer, setHasNewer] = useState(false);
  const atRef = useRef<string | null>(null); // лента начата с выбранного месяца ("2015-03"), null: с самых новых
  const [at, setAt] = useState<string | null>(null);

  // Другой альбом или другой человек: переход к месяцу из прошлого альбома не переносится.
  useEffect(() => { atRef.current = null; setAt(null); }, [albumId, person]);

  const loadMore = useCallback(
    async (reset = false, clear = false) => {
      if (!reset && (busy.current || done.current)) return;
      const my = reset ? ++gen.current : gen.current;
      if (reset) {
        cursor.current = null;
        done.current = false;
        if (albumId || person || clear) {
          setFiles([]);
          setLoaded(false);
        }
      }
      busy.current = true;
      setLoading(true);
      setError(null);
      try {
        const before = reset ? undefined : (cursor.current ?? undefined);
        const r = albumId ? await api.albumFiles(albumId, before, reset ? (atRef.current ?? undefined) : undefined) : await api.list(trashed, before, kind, atRef.current ?? undefined, undefined, person);
        if (my !== gen.current) return;
        cursor.current = r.next;
        done.current = r.next === null;
        if (reset) { prevRef.current = ('prev' in r ? r.prev : null) ?? null; setHasNewer(prevRef.current !== null); }
        setHasMore(r.next !== null);
        setFiles((prev) => {
          if (reset) return r.files;
          const seen = new Set(prev.map((f) => f.id));
          return [...prev, ...r.files.filter((f) => !seen.has(f.id))];
        });
        setLoaded(true);
      } catch (e) {
        if (my === gen.current) setError(e instanceof ApiError ? e.message : 'Не удалось загрузить список');
      } finally {
        if (my === gen.current) {
          busy.current = false;
          setLoading(false);
        }
      }
    },
    [trashed, albumId, kind, person],
  );

  // Догрузить файлы новее самого верхнего (лента начата с выбранного месяца). Вызывающий сам сохраняет положение прокрутки.
  const loadNewer = useCallback(async () => {
    const key = prevRef.current;
    if (!key || newerBusy.current || trashed) return;
    const my = gen.current;
    newerBusy.current = true;
    try {
      const r = albumId ? await api.albumFiles(albumId, undefined, undefined, key) : await api.list(false, undefined, kind, undefined, key, person);
      if (my !== gen.current) return;
      prevRef.current = r.prev ?? null;
      setHasNewer(prevRef.current !== null);
      setFiles((prev) => {
        const seen = new Set(prev.map((f) => f.id));
        return [...r.files.filter((f) => !seen.has(f.id)), ...prev];
      });
    } catch {
      /* повторится при следующем появлении верхнего края */
    } finally {
      newerBusy.current = false;
    }
  }, [trashed, albumId, kind, person]);

  // Перейти к месяцу ("2015-03") или вернуться к самым новым (null). Сайт показывает ленту с этого месяца вниз.
  const jump = useCallback(async (to: string | null) => {
    atRef.current = to;
    setAt(to);
    await loadMore(true, true); // старая лента убирается сразу: экран откликается на нажатие, а новые данные приходят следом
  }, [loadMore]);

  // Новый файл попадает наверх ленты; пока выше есть ещё не загруженные новые файлы, он покажется при догрузке.
  const add = useCallback((f: FileItem) => { if (prevRef.current === null) setFiles((prev) => insertSorted(prev, f)); }, []);
  const remove = useCallback((id: string) => setFiles((prev) => prev.filter((f) => f.id !== id)), []);

  const patch = useCallback((ids: Set<string>, change: Partial<FileItem>) => setFiles((prev) => prev.map((f) => (ids.has(f.id) ? { ...f, ...change } : f))), []);

  return { files, hasMore, loading, loaded, error, loadMore, add, remove, patch, at, jump, hasNewer, loadNewer };
}
