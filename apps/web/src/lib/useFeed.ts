import { useCallback, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type { FileItem } from '../types';
import { insertSorted } from './group';

// Список файлов с подгрузкой страницами. trashed=true даёт корзину.
export function useFeed(trashed: boolean) {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const cursor = useRef<string | null>(null);
  const done = useRef(false); // последняя страница уже получена

  const loadMore = useCallback(
    async (reset = false) => {
      if (busy.current || (!reset && done.current)) return;
      busy.current = true;
      setLoading(true);
      setError(null);
      try {
        const r = await api.list(trashed, reset ? undefined : (cursor.current ?? undefined));
        cursor.current = r.next;
        done.current = r.next === null;
        setHasMore(r.next !== null);
        setFiles((prev) => {
          if (reset) return r.files;
          const seen = new Set(prev.map((f) => f.id));
          return [...prev, ...r.files.filter((f) => !seen.has(f.id))];
        });
        setLoaded(true);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Не удалось загрузить список');
      } finally {
        busy.current = false;
        setLoading(false);
      }
    },
    [trashed],
  );

  const add = useCallback((f: FileItem) => setFiles((prev) => insertSorted(prev, f)), []);
  const remove = useCallback((id: string) => setFiles((prev) => prev.filter((f) => f.id !== id)), []);

  return { files, hasMore, loading, loaded, error, loadMore, add, remove };
}
