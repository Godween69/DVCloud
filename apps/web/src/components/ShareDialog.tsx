import { Check, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { Album, Person } from '../types';

// Окно «Поделиться альбомом»: отметьте людей, и они увидят фото альбома у себя (диск при этом не растёт).
export function ShareDialog({ album, onClose, onError, onChanged }: { album: Album; onClose: () => void; onError: (m: string) => void; onChanged: (sharedWith: number) => void }) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [shared, setShared] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.people(), api.shares(album.id)])
      .then(([all, now]) => { setPeople(all); setShared(new Set(now.map((p) => p.login))); })
      .catch((e) => { onError(e instanceof ApiError ? e.message : 'Не удалось загрузить список людей'); onClose(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [album.id]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);

  async function toggle(p: Person) {
    const on = !shared.has(p.login);
    setBusy(p.login);
    try {
      if (on) await api.share(album.id, p.login);
      else await api.unshare(album.id, p.login);
      const next = new Set(shared);
      if (on) next.add(p.login); else next.delete(p.login);
      setShared(next);
      onChanged(next.size);
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Не получилось');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 sm:items-center sm:p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={`Поделиться альбомом «${album.name}»`} onClick={(e) => e.stopPropagation()} className="flex max-h-[80vh] w-full max-w-md flex-col glass-strong rounded-t-3xl text-gray-900 sm:rounded-3xl dark:text-gray-100">
        <div className="flex items-center gap-2 border-b border-paper-300 px-4 py-3 dark:border-gray-800">
          <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">Поделиться «{album.name}»</h2>
          <button type="button" onClick={onClose} aria-label="Закрыть" className="flex size-8 items-center justify-center rounded-lg text-gray-500 hover:bg-paper-200 dark:hover:bg-gray-800"><X className="size-5" aria-hidden /></button>
        </div>
        <p className="border-b border-paper-300 px-4 py-2.5 text-sm text-gray-600 dark:border-gray-800 dark:text-gray-400">Выбранные люди видят фото этого альбома и могут сохранить их себе. Менять альбом они не могут. Новые фото в альбоме видны им сразу.</p>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {people === null ? (
            <div className="flex justify-center py-8 text-gray-500"><Loader2 className="size-5 animate-spin" aria-label="Загружаем" /></div>
          ) : people.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-gray-600 dark:text-gray-400">В облаке пока нет других людей.</p>
          ) : (
            <ul>
              {people.map((p) => (
                <li key={p.login}>
                  <button type="button" disabled={busy === p.login} onClick={() => toggle(p)} aria-pressed={shared.has(p.login)} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm hover:bg-paper-200 disabled:opacity-50 dark:hover:bg-gray-800">
                    <span className={`flex size-5 shrink-0 items-center justify-center rounded border ${shared.has(p.login) ? 'border-violet-600 bg-violet-600 text-white' : 'border-gray-400'}`}>{shared.has(p.login) && <Check className="size-3.5" strokeWidth={3} aria-hidden />}</span>
                    <span className="min-w-0 flex-1 truncate font-medium">{p.displayName}</span>
                    <span className="text-gray-500">{p.login}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
