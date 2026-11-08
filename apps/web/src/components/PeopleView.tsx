import { ArrowLeft, Check, Combine, Eye, EyeOff, Loader2, Pencil, PawPrint, Trash2, UserRound, Users, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ApiError, cropUrl } from '../api';
import { countFiles } from '../lib/format';
import { sortGroups } from '../lib/people';
import type { PeopleGroup, PeopleList } from '../types';

const msg = (e: unknown, fallback: string): string => (e instanceof ApiError ? e.message : fallback);

function Cover({ p, size }: { p: PeopleGroup; size: string }) {
  return (
    <span className={`relative block shrink-0 overflow-hidden rounded-full bg-paper-200 dark:bg-gray-800 ${size}`}>
      <img src={cropUrl(p.cover)} alt="" loading="lazy" draggable={false} className="size-full object-cover" />
    </span>
  );
}

// Вкладка «Люди»: круглые обложки групп. Названные первыми; безымянные просят имя. Скрытые прячутся и показываются кнопкой.
export function PeopleView({ list, showHidden, onShowHidden, onOpen, onReload }: {
  list: PeopleList | null;
  showHidden: boolean;
  onShowHidden: (on: boolean) => void;
  onOpen: (p: PeopleGroup) => void;
  onReload: () => void;
}) {
  useEffect(() => { onReload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  if (!list) return <p className="mt-20 flex items-center justify-center gap-2 text-gray-600 dark:text-gray-400" role="status"><Loader2 className="size-5 animate-spin" aria-hidden />Загружаем…</p>;
  const off = !list.enabled.faces && !list.enabled.pets;
  const groups = sortGroups(list.people);
  const hiddenCount = groups.filter((g) => g.hidden).length;
  const shown = groups.filter((g) => showHidden || !g.hidden);

  return (
    <div className="mx-auto max-w-[1200px] px-3 py-6 sm:px-6">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Люди и питомцы</h1>
        {(hiddenCount > 0 || showHidden) && (
          <button type="button" onClick={() => onShowHidden(!showHidden)} aria-pressed={showHidden} className="ml-auto flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-gray-600 transition-colors hover:bg-paper-200 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white">
            {showHidden ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
            {showHidden ? 'Не показывать скрытых' : `Показать скрытых: ${hiddenCount}`}
          </button>
        )}
      </div>

      {off && <p className="max-w-xl text-gray-600 dark:text-gray-400">Распознавание лиц и питомцев выключено администратором.</p>}
      {!off && shown.length === 0 && (
        <div className="mx-auto flex max-w-md flex-col items-center py-16 text-center">
          <span className="mb-5 flex size-16 items-center justify-center rounded-2xl bg-paper-200 text-gray-500 dark:bg-gray-900"><Users className="size-8" aria-hidden /></span>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Пока никого не нашли</h2>
          <p className="mt-2 text-gray-600 dark:text-gray-400">Облако ищет лица и питомцев в фоне, когда нет загрузок. Группа появляется, когда человек встретился на трёх фото. Можно и вручную: откройте фото, нажмите на рамку и назовите.</p>
        </div>
      )}

      <ul className="grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7">
        {shown.map((p) => (
          <li key={p.id}>
            <button type="button" onClick={() => onOpen(p)} className={`group flex w-full flex-col items-center gap-2 rounded-xl p-1 text-center outline-none focus-visible:ring-2 focus-visible:ring-violet-500 ${p.hidden ? 'opacity-50' : ''}`}>
              <Cover p={p} size="aspect-square w-full max-w-32 transition-transform group-hover:scale-105" />
              <span className="w-full min-w-0">
                <span className={`block truncate text-sm font-medium ${p.name ? 'text-gray-900 dark:text-white' : 'text-violet-700 dark:text-violet-300'}`}>
                  {p.name ?? (p.kind === 'pet' ? 'Дайте имя питомцу' : 'Дайте имя')}
                </span>
                <span className="block text-xs text-gray-500">{countFiles(p.count)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Шапка страницы человека: имя (правится на месте), скрыть, объединить с другой группой, распустить.
export function PersonHeader({ person, others, count, onBack, onChanged, onGone, onError }: {
  person: PeopleGroup;
  others: PeopleGroup[]; // другие группы того же вида для объединения
  count: number | null;
  onBack: () => void;
  onChanged: (p: PeopleGroup) => void;
  onGone: (text: string) => void;
  onError: (m: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(person.name ?? '');
  const [busy, setBusy] = useState(false);
  const [merging, setMerging] = useState(false);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { setName(person.name ?? ''); setEditing(!person.name); setMerging(false); setConfirm(false); }, [person.id, person.name]);

  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try { await fn(); } catch (e) { onError(msg(e, 'Не получилось')); } finally { setBusy(false); }
  }
  const save = () => run(async () => {
    const v = name.trim();
    if (!v) { if (person.name) setEditing(false); return; }
    if (v === person.name) { setEditing(false); return; }
    await api.renamePerson(person.id, v);
    onChanged({ ...person, name: v });
    setEditing(false);
  });
  const hide = () => run(async () => { await api.hidePerson(person.id, !person.hidden); onChanged({ ...person, hidden: !person.hidden }); });
  const merge = (into: PeopleGroup) => run(async () => {
    await api.mergePeople(into.id, person.id);
    onGone(`Объединено: теперь это «${into.name ?? 'группа без имени'}»`);
  });
  const dissolve = () => run(async () => { await api.deletePerson(person.id); onGone('Группа распущена, фото остались'); });
  const small = 'flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-gray-700 transition-colors hover:bg-paper-200 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-800';

  return (
    <div className="mx-auto max-w-[1600px] px-3 pt-5 sm:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onBack} aria-label="К списку людей" className="flex size-9 items-center justify-center rounded-lg text-gray-600 hover:bg-paper-200 dark:text-gray-400 dark:hover:bg-gray-800"><ArrowLeft className="size-5" aria-hidden /></button>
        <Cover p={person} size="size-12" />
        <div className="min-w-0 flex-1">
          {editing ? (
            <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="flex items-center gap-2">
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label="Имя" placeholder={person.kind === 'pet' ? 'Как зовут питомца?' : 'Как зовут?'}
                className="min-w-0 max-w-xs flex-1 rounded-lg border border-paper-300 bg-paper-50 px-3 py-1.5 text-base outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/30 dark:border-gray-700 dark:bg-gray-900 dark:text-white" />
              <button type="submit" disabled={busy || !name.trim()} aria-label="Сохранить имя" className="flex size-9 items-center justify-center rounded-lg bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50"><Check className="size-4" aria-hidden /></button>
              {person.name && <button type="button" onClick={() => { setName(person.name ?? ''); setEditing(false); }} aria-label="Отмена" className="flex size-9 items-center justify-center rounded-lg text-gray-600 hover:bg-paper-200 dark:text-gray-400 dark:hover:bg-gray-800"><X className="size-4" aria-hidden /></button>}
            </form>
          ) : (
            <h1 className="flex items-center gap-2 truncate text-xl font-semibold text-gray-900 dark:text-white">
              {person.kind === 'pet' ? <PawPrint className="size-5 shrink-0 text-gray-500" aria-hidden /> : <UserRound className="size-5 shrink-0 text-gray-500" aria-hidden />}
              <span className="truncate">{person.name}</span>
              <button type="button" onClick={() => setEditing(true)} aria-label="Изменить имя" title="Изменить имя" className="flex size-7 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-paper-200 hover:text-gray-900 dark:hover:bg-gray-800 dark:hover:text-white"><Pencil className="size-4" aria-hidden /></button>
            </h1>
          )}
          <p className="text-sm text-gray-600 dark:text-gray-400">{countFiles(count ?? person.count)}{person.hidden ? ' · скрыта из списка' : ''}</p>
        </div>
        <div className="flex flex-wrap gap-1">
          <button type="button" onClick={hide} disabled={busy} className={small}>{person.hidden ? <Eye className="size-4" aria-hidden /> : <EyeOff className="size-4" aria-hidden />}{person.hidden ? 'Вернуть в список' : 'Скрыть'}</button>
          {others.length > 0 && <button type="button" onClick={() => { setMerging((v) => !v); setConfirm(false); }} aria-expanded={merging} className={small}><Combine className="size-4" aria-hidden />Это тот же человек</button>}
          <button type="button" onClick={() => { setConfirm((v) => !v); setMerging(false); }} aria-expanded={confirm} className={small}><Trash2 className="size-4" aria-hidden />Распустить</button>
        </div>
      </div>

      {merging && (
        <div className="mt-3 rounded-xl border border-paper-300 bg-paper-50 p-3 dark:border-gray-800 dark:bg-gray-900">
          <p className="mb-2 text-sm text-gray-700 dark:text-gray-300">Выберите, к кому присоединить эти фото. Эта группа исчезнет.</p>
          <ul className="flex flex-wrap gap-2">
            {sortGroups(others).map((o) => (
              <li key={o.id}>
                <button type="button" disabled={busy} onClick={() => void merge(o)} className="flex items-center gap-2 rounded-full border border-paper-300 py-1 pl-1 pr-3 text-sm hover:border-violet-400 disabled:opacity-50 dark:border-gray-700 dark:text-white">
                  <Cover p={o} size="size-7" />{o.name ?? 'Без имени'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {confirm && (
        <div role="alert" className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
          <span className="min-w-0 flex-1">Группа и имя исчезнут, сами фото останутся. Лица могут собраться в новую группу позже; чтобы этого не было, лучше скрыть группу.</span>
          <button type="button" disabled={busy} onClick={() => void dissolve()} className="rounded-lg bg-red-600 px-3 py-1.5 font-medium text-white hover:bg-red-500 disabled:opacity-50">Распустить</button>
          <button type="button" onClick={() => setConfirm(false)} className="rounded-lg px-3 py-1.5 hover:bg-red-100 dark:hover:bg-red-950/60">Отмена</button>
        </div>
      )}
    </div>
  );
}
