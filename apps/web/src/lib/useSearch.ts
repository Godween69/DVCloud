import { useCallback, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type { FileItem, FoundPerson } from '../types';

// Поиск по смыслу: запрос, результаты в порядке подходящести, ошибка. Устаревший ответ (человек успел спросить другое) отбрасывается.
export function useSearch() {
  const [query, setQuery] = useState('');
  const [asked, setAsked] = useState<string | null>(null); // что искали в последний раз
  const [files, setFiles] = useState<FileItem[]>([]);
  const [people, setPeople] = useState<FoundPerson[]>([]); // узнанные в запросе имена («Валя»)
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gen = useRef(0);

  const run = useCallback(async (q: string) => {
    const text = q.trim();
    if (!text) return;
    const my = ++gen.current;
    setQuery(text);
    setLoading(true);
    setError(null);
    try {
      const r = await api.search(text);
      if (my !== gen.current) return;
      setFiles(r.files);
      setPeople(r.people ?? []);
      setAsked(text);
    } catch (e) {
      if (my !== gen.current) return;
      setFiles([]);
      setPeople([]);
      setAsked(null);
      setError(e instanceof ApiError ? e.message : 'Не получилось найти');
    } finally {
      if (my === gen.current) setLoading(false);
    }
  }, []);

  const clear = useCallback(() => {
    gen.current++;
    setQuery('');
    setAsked(null);
    setFiles([]);
    setPeople([]);
    setError(null);
    setLoading(false);
  }, []);

  const remove = useCallback((id: string) => setFiles((prev) => prev.filter((f) => f.id !== id)), []);

  return { query, setQuery, asked, files, people, loading, error, run, clear, remove };
}
