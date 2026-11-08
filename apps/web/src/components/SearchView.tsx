import { Loader2, PawPrint, Search, SearchX, UserRound, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { EXAMPLES, indexNote } from '../lib/search';
import { countFiles } from '../lib/format';
import type { useSearch } from '../lib/useSearch';
import type { PeopleGroup, SearchStatus } from '../types';
import { GRID, Tile } from './Gallery';

type SearchState = ReturnType<typeof useSearch>;

// Поиск словами: «собака на пляже». Результаты идут по убыванию подходящести (не по датам), поэтому своя сетка вместо ленты по месяцам.
export function SearchView({ search, status, named, onOpen, onPerson }: { search: SearchState; status: SearchStatus | null; named: PeopleGroup[]; onOpen: (id: string) => void; onPerson: (id: string) => void }) {
  const semantic = !!status?.enabled; // поиск по смыслу включён; без него ищутся только имена людей и питомцев
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const note = semantic ? indexNote(status) : '';
  const submit = (q: string) => { void search.run(q); };

  return (
    <div className="mx-auto max-w-[1600px] px-3 py-6 sm:px-6">
      <form role="search" onSubmit={(e) => { e.preventDefault(); submit(search.query); }} className="mx-auto flex max-w-2xl items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-5 -translate-y-1/2 text-gray-500" aria-hidden />
          <input ref={input} type="text" enterKeyHint="search" autoComplete="off" value={search.query} onChange={(e) => search.setQuery(e.target.value)} maxLength={200} placeholder={semantic ? (named.length ? 'Что ищем? Например: собака на пляже или фото с Валей' : 'Что ищем? Например: собака на пляже') : 'Имя человека или питомца'} aria-label="Поиск"
            className="w-full rounded-xl border border-paper-300 bg-paper-50 py-3 pl-11 pr-10 text-base text-gray-900 outline-none transition-colors placeholder:text-gray-500 focus:border-violet-500 focus:ring-2 focus:ring-violet-500/30 dark:border-gray-700 dark:bg-gray-900 dark:text-white" />
          {search.query && (
            <button type="button" onClick={() => { search.clear(); input.current?.focus(); }} aria-label="Очистить запрос" className="absolute right-2 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-lg text-gray-500 hover:bg-paper-200 hover:text-gray-900 dark:hover:bg-gray-800 dark:hover:text-white">
              <X className="size-4" aria-hidden />
            </button>
          )}
        </div>
        <button type="submit" disabled={!search.query.trim() || search.loading} className="rounded-xl bg-violet-600 px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50">Найти</button>
      </form>

      {note && <p className="mx-auto mt-3 max-w-2xl text-center text-sm text-gray-600 dark:text-gray-400">{note}</p>}

      {search.loading && (
        <p className="mt-16 flex items-center justify-center gap-2 text-gray-600 dark:text-gray-400" role="status"><Loader2 className="size-5 animate-spin" aria-hidden />Ищем…</p>
      )}

      {!search.loading && search.error && <p role="alert" className="mx-auto mt-10 max-w-md rounded-xl bg-red-50 px-4 py-3 text-center text-sm text-red-800 dark:bg-red-950/40 dark:text-red-300">{search.error}</p>}

      {!search.loading && !search.error && search.asked === null && (
        <div className="mx-auto mt-10 max-w-2xl text-center">
          <p className="text-gray-600 dark:text-gray-400">{semantic ? 'Опишите словами, что на фото или видео. Поиск понимает смысл, а не названия файлов. Можно назвать и человека или питомца: «фото с Валей».' : 'Введите имя человека или питомца, которого вы назвали на вкладке «Люди».'}</p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {!semantic && named.slice(0, 8).map((p) => (
              <button key={p.id} type="button" onClick={() => submit(p.name!)} className="rounded-full border border-paper-300 bg-paper-50 px-3.5 py-1.5 text-sm text-gray-700 transition-colors hover:border-violet-400 hover:text-violet-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:text-violet-300">{p.name}</button>
            ))}
            {semantic && EXAMPLES.map((x) => (
              <button key={x} type="button" onClick={() => submit(x)} className="rounded-full border border-paper-300 bg-paper-50 px-3.5 py-1.5 text-sm text-gray-700 transition-colors hover:border-violet-400 hover:text-violet-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:text-violet-300">{x}</button>
            ))}
          </div>
        </div>
      )}

      {!search.loading && !search.error && search.asked !== null && search.files.length === 0 && (
        <div className="mx-auto mt-16 flex max-w-md flex-col items-center text-center">
          <span className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-paper-200 text-gray-500 dark:bg-gray-900"><SearchX className="size-7" aria-hidden /></span>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Ничего не нашлось</h2>
          <p className="mt-1.5 text-gray-600 dark:text-gray-400">Попробуйте другими словами или короче: «море», «кошка», «зима».</p>
        </div>
      )}

      {!search.loading && !search.error && search.files.length > 0 && (
        <>
          {search.people.length > 0 && (
            <div className="mt-8 flex flex-wrap items-center gap-2">
              <span className="text-sm text-gray-600 dark:text-gray-400">Нашли в запросе:</span>
              {search.people.map((p) => {
                const pet = named.find((n) => n.id === p.id)?.kind === 'pet';
                return (
                  <button key={p.id} type="button" onClick={() => onPerson(p.id)} className="flex items-center gap-1.5 rounded-full bg-violet-100 px-3 py-1 text-sm font-medium text-violet-800 hover:bg-violet-200 dark:bg-violet-950/60 dark:text-violet-200 dark:hover:bg-violet-900/60">
                    {pet ? <PawPrint className="size-4" aria-hidden /> : <UserRound className="size-4" aria-hidden />}{p.name}
                  </button>
                );
              })}
            </div>
          )}
          <p className={`mb-3 ${search.people.length ? 'mt-4' : 'mt-8'} text-sm text-gray-600 dark:text-gray-400`} aria-live="polite">Найдено: {countFiles(search.files.length)}. Лучшие совпадения первыми.</p>
          <div className={`grid gap-1 ${GRID.m}`}>
            {search.files.map((f) => <Tile key={f.id} file={f} onOpen={onOpen} onPick={() => {}} selecting={false} picked={false} quick={null} />)}
          </div>
        </>
      )}
    </div>
  );
}
