import { useCallback, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type { FileItem } from '../types';
import { insertSorted } from './group';

// Список файлов с подгрузкой страницами. trashed=true даёт корзину, albumId даёт файлы одного альбома.
export function useFeed(trashed: boolean, albumId?: string, kind?: 'photos' | 'videos' | 'screenshots') {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const cursor = useRef<string | null>(null);
  const done = useRef(false); // последняя страница уже получена
  const gen = useRef(0); // номер запуска: ответ устаревшего запуска (другой альбом) отбрасывается

  const loadMore = useCallback(
    async (reset = false) => {
      if (!reset && (busy.current || done.current)) return;
      const my = reset ? ++gen.current : gen.current;
      if (reset) {
        cursor.current = null;
        done.current = false;
        if (albumId) {
          setFiles([]);
          setLoaded(false);
        }
      }
      busy.current = true;
      setLoading(true);
      setError(null);
      try {
        const before = reset ? undefined : (cursor.current ?? undefined);
        const r = albumId ? await api.albumFiles(albumId, before) : await api.list(trashed, before, kind);
        if (my !== gen.current) return;
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
        if (my === gen.current) setError(e instanceof ApiError ? e.message : 'Не удалось загрузить список');
      } finally {
        if (my === gen.current) {
          busy.current = false;
          setLoading(false);
        }
      }
    },
    [trashed, albumId, kind],
  );

  const add = useCallback((f: FileItem) => setFiles((prev) => insertSorted(prev, f)), []);
  const remove = useCallback((id: string) => setFiles((prev) => prev.filter((f) => f.id !== id)), []);

  return { files, hasMore, loading, loaded, error, loadMore, add, remove };
}
