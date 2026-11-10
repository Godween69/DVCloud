import { ArrowLeft, Check, Combine, Eye, EyeOff, HelpCircle, Image as ImageIcon, Loader2, Lock, Pencil, PawPrint, Plus, Trash2, UserRound, Users, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ApiError, cropUrl, thumbUrl } from '../api';
import { countFiles } from '../lib/format';
import { mergePlan, sortGroups } from '../lib/people';
import type { FaceGuess, PeopleGroup, PeopleList } from '../types';

const tbtn = 'flex items-center gap-2 rounded-xl px-3 py-1.5 text-sm text-gray-700 transition-colors hover:bg-black/5 aria-pressed:bg-violet-600/15 aria-pressed:text-violet-800 dark:text-gray-300 dark:hover:bg-white/10 dark:aria-pressed:text-violet-200';
const msg = (e: unknown, fallback: string): string => (e instanceof ApiError ? e.message : fallback);

function Cover({ p, size }: { p: PeopleGroup; size: string }) {
  return (
    <span className={`relative block shrink-0 overflow-hidden rounded-full bg-paper-200 shadow-[0_2px_14px_-4px_rgba(15,23,42,0.35)] ring-1 ring-black/5 dark:bg-gray-800 dark:ring-white/10 ${size}`}>
      <img src={cropUrl(p.cover)} alt="" loading="lazy" draggable={false} className="size-full object-cover" />
    </span>
  );
}

// Панель «Альбом по людям»: у каждой группы три состояния по кругу: нет, «обязательно», «не должно быть».
function AlbumByPeople({ groups, onClose }: { groups: PeopleGroup[]; onClose: () => void }) {
  const [state, setState] = useState<Record<string, 'in' | 'out'>>({});
  const [name, setName] = useState('');
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const inc = Object.keys(state).filter((k) => state[k] === 'in');
  const exc = Object.keys(state).filter((k) => state[k] === 'out');
  useEffect(() => {
    setCount(null);
    if (inc.length === 0) return;
    let live = true;
    const t = setTimeout(() => { api.matchPeople(inc, exc).then((r) => { if (live) setCount(r.count); }).catch(() => { if (live) setCount(null); }); }, 300);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inc.join(','), exc.join(',')]);
  const cycle = (id: string) => { setDone(null); setState((prev) => { const n = { ...prev }; if (!n[id]) n[id] = 'in'; else if (n[id] === 'in') n[id] = 'out'; else delete n[id]; return n; }); };
  async function create() {
    if (busy || inc.length === 0 || !name.trim()) return;
    setBusy(true); setProblem(null); setDone(null);
    try {
      const r = await api.albumByPeople(name.trim(), inc, exc);
      setDone(`Альбом «${r.name}» создан: ${countFiles(r.added)}. Он во вкладке «Альбомы».`);
      setName('');
    } catch (e) { setProblem(msg(e, 'Не получилось создать альбом')); } finally { setBusy(false); }
  }
  return (
    <section aria-label="Альбом по людям" className="glass mb-6 rounded-xl p-4">
      <div className="mb-3 flex items-start gap-3">
        <p className="min-w-0 flex-1 text-sm text-gray-700 dark:text-gray-300">Нажимайте на людей: один раз «обязательно есть на фото» (зелёная рамка), второй раз «не должно быть» (красная), третий снимает выбор. Альбом соберётся из фото на сегодня.</p>
        <button type="button" onClick={onClose} aria-label="Закрыть" className="flex size-8 shrink-0 items-center justify-center rounded-lg text-gray-600 hover:bg-paper-200 dark:text-gray-400 dark:hover:bg-gray-800"><X className="size-4" aria-hidden /></button>
      </div>
      <ul className="mb-3 flex flex-wrap gap-2">
        {groups.map((g) => (
          <li key={g.id}>
            <button type="button" onClick={() => cycle(g.id)} aria-pressed={!!state[g.id]} title={state[g.id] === 'in' ? 'Обязательно есть' : state[g.id] === 'out' ? 'Не должно быть' : 'Не учитывать'}
              className={`flex items-center gap-2 rounded-full border-2 py-1 pl-1 pr-3 text-sm dark:text-white ${state[g.id] === 'in' ? 'border-green-500 bg-green-500/10' : state[g.id] === 'out' ? 'border-red-500 bg-red-500/10' : 'border-paper-300 dark:border-gray-700'}`}>
              <Cover p={g} size="size-7" />{g.name ?? 'Без имени'}
              {state[g.id] === 'in' && <span className="text-green-700 dark:text-green-400">обязательно</span>}
              {state[g.id] === 'out' && <span className="text-red-700 dark:text-red-400">не должно быть</span>}
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={(e) => { e.preventDefault(); void create(); }} className="flex flex-wrap items-center gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label="Название альбома" placeholder="Название альбома"
          className="min-w-0 max-w-xs flex-1 rounded-lg border border-paper-300 bg-paper-50 px-3 py-1.5 text-base outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/30 dark:border-gray-700 dark:bg-gray-900 dark:text-white" />
        <button type="submit" disabled={busy || inc.length === 0 || !name.trim() || count === 0} className="flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Check className="size-4" aria-hidden />}OK
        </button>
        <span className="text-sm text-gray-600 dark:text-gray-400" aria-live="polite">{inc.length === 0 ? 'Выберите хотя бы одного, кто обязательно должен быть' : count === null ? 'Считаем…' : count === 0 ? 'Таких фото нет' : `Подходит: ${countFiles(count)}`}</span>
      </form>
      {problem && <p className="mt-2 text-sm text-red-600 dark:text-red-400" role="alert">{problem}</p>}
      {done && <p className="mt-2 text-sm text-green-700 dark:text-green-400" role="status">{done}</p>}
    </section>
  );
}

// «Проверить догадки»: лица, похожие на названного человека, но не настолько, чтобы облако присоединило их само.
// Вопросы идут по одному. «Да» назначает лицо. «Нет» запоминается сразу (этого человека для этого лица больше не предложат),
// и открывается выбор: кто же это на самом деле, «не знаю» (лицо больше не спрашивается), «другой» (вписать имя), «не человек».
// Страница не перезагружается, ответы учат облако узнавать человека точнее.
function Guesses({ onClose, onAnswered }: { onClose: () => void; onAnswered: () => void }) {
  const [items, setItems] = useState<FaceGuess[] | null>(null);
  const [people, setPeople] = useState<PeopleGroup[]>([]);
  const [stage, setStage] = useState<'ask' | 'pick'>('ask');
  const [q, setQ] = useState('');
  const [other, setOther] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  const load = () => { setItems(null); setStage('ask'); api.guesses(24).then(setItems).catch((e) => { setItems([]); setProblem(msg(e, 'Не получилось загрузить')); }); };
  useEffect(() => { load(); api.peopleGroups().then((l) => setPeople(l.people.filter((p) => p.name && p.kind === 'person'))).catch(() => undefined); }, []);
  const cur = items && items.length > 0 ? items[0] : null;
  const next = () => { setItems((prev) => (prev ?? []).slice(1)); setStage('ask'); setQ(''); setOther(false); setNewName(''); setAsked((n) => n + 1); onAnswered(); };
  async function run(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setProblem(null);
    try { await fn(); next(); } catch (e) { setProblem(msg(e, 'Не получилось')); } finally { setBusy(false); }
  }
  async function no() {
    if (!cur || busy) return;
    setBusy(true); setProblem(null);
    try { await api.rejectFace(cur.detectionId, cur.personId); setStage('pick'); } catch (e) { setProblem(msg(e, 'Не получилось')); } finally { setBusy(false); }
  }
  // Клавиши: Д / Y / Enter / → : да; Н / N / ← : нет. В выборе клавиши отданы поиску.
  useEffect(() => {
    if (!cur || stage !== 'ask') return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Enter' || e.key === 'ArrowRight' || e.code === 'KeyY') { e.preventDefault(); void run(() => api.assignFace(cur.detectionId, cur.personId)); }
      else if (e.key === 'ArrowLeft' || e.code === 'KeyN') { e.preventDefault(); void no(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur?.detectionId, stage, busy]);
  const filtered = people.filter((p) => cur && p.id !== cur.personId && (q.trim() === '' || (p.name ?? '').toLowerCase().includes(q.trim().toLowerCase())));
  const ghost = 'rounded-xl px-3 py-2 text-sm text-gray-700 hover:bg-black/5 dark:text-gray-300 dark:hover:bg-white/10';
  return (
    <section aria-label="Проверить догадки" className="glass mb-6 rounded-2xl p-4">
      <div className="mb-3 flex items-start gap-3">
        <p className="min-w-0 flex-1 text-sm text-gray-700 dark:text-gray-300">Облако не уверено в этих лицах. Ваши ответы учат его узнавать людей точнее, а одно и то же лицо больше не спрашивается.{asked > 0 ? ` Отвечено: ${asked}.` : ''}{items && items.length > 0 ? ` Осталось: ${items.length}.` : ''}</p>
        <button type="button" onClick={onClose} aria-label="Закрыть" className="flex size-8 shrink-0 items-center justify-center rounded-lg text-gray-600 hover:bg-black/5 dark:text-gray-400 dark:hover:bg-white/10"><X className="size-4" aria-hidden /></button>
      </div>
      {items === null && <p className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400" role="status"><Loader2 className="size-4 animate-spin" aria-hidden />Ищем сомнительные лица…</p>}
      {items && !cur && <p className="text-sm text-gray-600 dark:text-gray-400">{asked > 0 ? 'Больше вопросов нет. ' : 'Сомнительных лиц нет. '}<button type="button" onClick={load} className="text-violet-700 underline dark:text-violet-300">Проверить ещё раз</button></p>}
      {cur && (
        <div className="mx-auto flex max-w-xl flex-col items-center gap-4 sm:flex-row sm:items-start">
          <div className="flex shrink-0 items-end gap-2">
            <img key={cur.detectionId} src={cropUrl(cur.detectionId)} alt="Лицо" draggable={false} className="size-40 rounded-2xl object-cover shadow-[0_8px_30px_-8px_rgba(15,23,42,0.5)] ring-1 ring-black/10 sm:size-48" />
            <img src={thumbUrl(cur.fileId)} alt="Снимок целиком" draggable={false} className="size-16 rounded-xl object-cover opacity-90 ring-1 ring-black/10" title="Снимок, на котором найдено лицо" />
          </div>
          <div className="w-full min-w-0 flex-1">
            {stage === 'ask' ? (
              <>
                <p className="mb-3 text-center text-lg font-semibold text-gray-900 dark:text-white sm:text-left">Это {cur.name}?</p>
                <div className="flex flex-wrap justify-center gap-2 sm:justify-start">
                  <button type="button" disabled={busy} onClick={() => void run(() => api.assignFace(cur.detectionId, cur.personId))} className="flex items-center gap-1.5 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white shadow-[0_0_20px_-6px_rgba(16,185,129,0.8)] hover:bg-emerald-500 disabled:opacity-50"><Check className="size-4" aria-hidden />Да</button>
                  <button type="button" disabled={busy} onClick={() => void no()} className="flex items-center gap-1.5 rounded-xl bg-rose-600 px-5 py-2.5 text-sm font-semibold text-white shadow-[0_0_20px_-6px_rgba(244,63,94,0.8)] hover:bg-rose-500 disabled:opacity-50"><X className="size-4" aria-hidden />Нет</button>
                  <button type="button" disabled={busy} onClick={() => void run(() => api.skipFace(cur.detectionId))} className={ghost}>Не знаю</button>
                </div>
                <p className="mt-3 text-center text-xs text-gray-500 sm:text-left">Клавиши: Enter или → — да, ← — нет.</p>
              </>
            ) : (
              <>
                <p className="mb-2 text-center text-base font-semibold text-gray-900 dark:text-white sm:text-left">Хорошо, это не {cur.name}. А кто?</p>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Найти среди людей" aria-label="Найти человека" autoFocus
                  className="mb-2 w-full rounded-lg border border-paper-300 bg-white/70 px-3 py-1.5 text-sm outline-none focus:border-violet-500 dark:border-gray-700 dark:bg-gray-900/60 dark:text-white" />
                <ul className="mb-2 flex max-h-40 flex-wrap gap-2 overflow-y-auto">
                  {filtered.map((p) => (
                    <li key={p.id}><button type="button" disabled={busy} onClick={() => void run(() => api.assignFace(cur.detectionId, p.id))} className="flex items-center gap-2 rounded-full border border-paper-300 bg-white/50 py-1 pl-1 pr-3 text-sm hover:border-violet-400 hover:bg-violet-500/10 disabled:opacity-50 dark:border-white/15 dark:bg-white/5 dark:text-white"><Cover p={p} size="size-7" />{p.name}</button></li>
                  ))}
                  {filtered.length === 0 && <li className="text-sm text-gray-500">Никого не нашли. Выберите «Другой» и впишите имя.</li>}
                </ul>
                {other ? (
                  <form onSubmit={(e) => { e.preventDefault(); const n = newName.trim(); if (n) void run(() => api.createPerson(cur.detectionId, n)); }} className="flex flex-wrap items-center gap-2">
                    <input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={80} placeholder="Имя нового человека" aria-label="Имя" autoFocus className="min-w-0 flex-1 rounded-lg border border-paper-300 bg-white/70 px-3 py-1.5 text-sm outline-none focus:border-violet-500 dark:border-gray-700 dark:bg-gray-900/60 dark:text-white" />
                    <button type="submit" disabled={busy || !newName.trim()} className="rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">Сохранить</button>
                  </form>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => setOther(true)} className={`${ghost} border border-paper-300 dark:border-white/15`}>Другой…</button>
                    <button type="button" disabled={busy} onClick={() => void run(() => api.skipFace(cur.detectionId))} className={ghost}>Не знаю</button>
                    <button type="button" disabled={busy} onClick={() => void run(() => api.ignoreFace(cur.detectionId, true))} className={ghost} title="Например, кошка или собака, принятая за лицо">Не человек</button>
                  </div>
                )}
              </>
            )}
            {problem && <p className="mt-2 text-sm text-red-600 dark:text-red-400" role="alert">{problem}</p>}
          </div>
        </div>
      )}
    </section>
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
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [byPeople, setByPeople] = useState(false);
  const [guessing, setGuessing] = useState(false);
  const stop = () => { setSelecting(false); setPicked(new Set()); setProblem(null); };
  const toggle = (id: string) => setPicked((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  if (!list) return <p className="mt-20 flex items-center justify-center gap-2 text-gray-600 dark:text-gray-400" role="status"><Loader2 className="size-5 animate-spin" aria-hidden />Загружаем…</p>;
  const off = !list.enabled.faces && !list.enabled.pets;
  const groups = sortGroups(list.people);
  const hiddenCount = groups.filter((g) => g.hidden).length;
  const shown = groups.filter((g) => showHidden || !g.hidden);
  const mergeable = shown.filter((g) => g.canMerge);
  const chosen = shown.filter((g) => picked.has(g.id));
  const plan = mergePlan(chosen);
  async function mergeChosen() {
    if (!plan || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.mergePeopleMany(plan.into.id, plan.from.map((p) => p.id));
      stop();
      onReload();
    } catch (e) {
      setProblem(msg(e, 'Не получилось объединить'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`mx-auto max-w-[1200px] px-3 py-6 sm:px-6 ${selecting ? "pb-28" : ""}`}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Люди и питомцы</h1>
        {(hiddenCount > 0 || showHidden) && (
          <button type="button" onClick={() => onShowHidden(!showHidden)} aria-pressed={showHidden} className="ml-auto flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-gray-600 transition-colors hover:bg-black/5 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/10 dark:hover:text-white">
            {showHidden ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
            {showHidden ? 'Не показывать скрытых' : `Показать скрытых: ${hiddenCount}`}
          </button>
        )}
      </div>
      {!off && (
        <div className="mb-5 flex flex-col gap-2">
          <div role="toolbar" aria-label="Работа с лицами" className="glass flex flex-wrap items-center gap-1 rounded-2xl p-1.5">
            <span className="px-2.5 text-xs font-medium text-gray-500">Лица</span>
            {list.enabled.faces && shown.some((g) => g.kind === 'person' && g.name) && (
              <button type="button" onClick={() => setGuessing((v) => !v)} aria-pressed={guessing} className={tbtn}><HelpCircle className="size-4" aria-hidden />Проверить догадки</button>
            )}
            {mergeable.length > 1 && (
              <button type="button" onClick={() => (selecting ? stop() : setSelecting(true))} aria-pressed={selecting} className={tbtn}><Combine className="size-4" aria-hidden />{selecting ? 'Отменить выбор' : 'Выбрать и объединить'}</button>
            )}
          </div>
          {shown.length > 0 && (
            <div role="toolbar" aria-label="Альбомы" className="glass flex flex-wrap items-center gap-1 rounded-2xl p-1.5">
              <span className="px-2.5 text-xs font-medium text-gray-500">Альбомы</span>
              <button type="button" onClick={() => setByPeople((v) => !v)} aria-pressed={byPeople} className={tbtn}><Plus className="size-4" aria-hidden />Альбом по людям</button>
            </div>
          )}
        </div>
      )}

      {guessing && !off && <Guesses onClose={() => setGuessing(false)} onAnswered={onReload} />}
      {byPeople && !off && <AlbumByPeople groups={groups.filter((g) => !g.hidden)} onClose={() => setByPeople(false)} />}
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
            <button type="button" onClick={() => (selecting ? (p.canMerge ? toggle(p.id) : undefined) : onOpen(p))} aria-pressed={selecting && p.canMerge ? picked.has(p.id) : undefined} aria-disabled={selecting && !p.canMerge ? true : undefined} title={selecting && !p.canMerge ? 'Названные и общие группы объединяет администратор' : undefined} className={`group flex w-full flex-col items-center gap-2 rounded-xl p-1 text-center outline-none focus-visible:ring-2 focus-visible:ring-violet-500 ${p.hidden ? 'opacity-50' : ''} ${selecting && !p.canMerge ? 'cursor-not-allowed opacity-30 saturate-50' : ''}`}>
              <span className="relative block w-full max-w-32">
                <Cover p={p} size={`aspect-square w-full transition-transform group-hover:scale-105 ${picked.has(p.id) ? 'ring-[3px] ring-violet-400/80' : ''}`} />
                {selecting && !p.canMerge && <span className="absolute right-1 top-1 grid size-6 place-items-center rounded-full bg-black/35 text-white" aria-hidden><Lock className="size-3.5" /></span>}
                {selecting && p.canMerge && <span className={`absolute right-1 top-1 flex size-6 items-center justify-center rounded-full border-2 border-white ${picked.has(p.id) ? 'bg-violet-600 text-white' : 'bg-black/30'}`}>{picked.has(p.id) && <Check className="size-4" aria-hidden />}</span>}
              </span>
              <span className="w-full min-w-0">
                <span className={`block truncate text-sm font-medium ${p.name ? 'text-gray-900 dark:text-white' : 'text-violet-700 dark:text-violet-300'}`}>
                  {p.name ?? (p.kind === 'pet' ? 'Дайте имя питомцу' : 'Дайте имя')}
                </span>
                <span className="block text-xs text-gray-500">{selecting && !p.canMerge ? 'только администратор' : countFiles(p.count)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      {selecting && (
        <div role="region" aria-label="Объединение групп" className="fixed inset-x-0 bottom-[3.75rem] z-30 sm:bottom-0 border-t border-paper-300 bg-paper-50/95 px-4 py-3 backdrop-blur dark:border-gray-800 dark:bg-gray-950/95">
          <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-4 gap-y-2">
            <span className="text-sm text-gray-700 dark:text-gray-300" aria-live="polite">
              {picked.size < 2 ? 'Отметьте несколько групп одного человека' : `Выбрано групп: ${picked.size}. Соберутся в «${plan?.into.name ?? 'группу без имени'}» (${countFiles(plan?.into.count ?? 0)}).`}
              {plan && plan.lostNames.length > 0 && <span className="block text-amber-700 dark:text-amber-400">Эти имена пропадут: {plan.lostNames.join(', ')}.</span>}
              {problem && <span className="block text-red-600 dark:text-red-400" role="alert">{problem}</span>}
            </span>
            <span className="ml-auto flex gap-2">
              <button type="button" onClick={stop} className="rounded-lg px-3 py-1.5 text-sm hover:bg-paper-200 dark:hover:bg-gray-800">Отмена</button>
              <button type="button" disabled={!plan || busy} onClick={() => void mergeChosen()} className="flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
                {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Combine className="size-4" aria-hidden />}Объединить
              </button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// Шапка страницы человека: имя (правится на месте), скрыть, объединить с другой группой, распустить.
export function PersonHeader({ person, others, count, coverPick, onCoverPick, onResetCover, onBack, onChanged, onGone, onError }: {
  coverPick: boolean; // включён выбор обложки: следующее нажатие на фото делает его обложкой
  onCoverPick: (on: boolean) => void;
  onResetCover: () => void;
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
  useEffect(() => { setName(person.name ?? ''); setEditing(!person.name && person.canName); setMerging(false); setConfirm(false); }, [person.id, person.name, person.canName]);

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
              {person.canName && <button type="button" onClick={() => setEditing(true)} aria-label="Изменить имя" title="Изменить имя" className="flex size-7 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-paper-200 hover:text-gray-900 dark:hover:bg-gray-800 dark:hover:text-white"><Pencil className="size-4" aria-hidden /></button>}
            </h1>
          )}
          <p className="text-sm text-gray-600 dark:text-gray-400">{countFiles(count ?? person.count)}{person.shared ? ' · общая группа' : ''}{person.hidden ? ' · скрыта у вас' : ''}</p>
        </div>
        <div className="flex flex-wrap gap-1">
          <button type="button" onClick={() => onCoverPick(!coverPick)} aria-pressed={coverPick} className={small}><ImageIcon className="size-4" aria-hidden />Обложка</button>
          <button type="button" onClick={hide} disabled={busy} className={small}>{person.hidden ? <Eye className="size-4" aria-hidden /> : <EyeOff className="size-4" aria-hidden />}{person.hidden ? 'Вернуть в список' : 'Скрыть'}</button>
          {person.canMerge && others.length > 0 && <button type="button" onClick={() => { setMerging((v) => !v); setConfirm(false); }} aria-expanded={merging} className={small}><Combine className="size-4" aria-hidden />Это тот же человек</button>}
          {person.canMerge && <button type="button" onClick={() => { setConfirm((v) => !v); setMerging(false); }} aria-expanded={confirm} className={small}><Trash2 className="size-4" aria-hidden />Распустить</button>}
        </div>
      </div>

      {coverPick && (
        <div role="status" className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-violet-300/60 bg-violet-500/10 p-3 text-sm text-gray-800 dark:border-violet-400/30 dark:text-gray-100">
          <span className="min-w-0 flex-1">Нажмите на фото ниже: лицо с него станет обложкой этой группы.</span>
          <button type="button" onClick={onResetCover} className="rounded-lg px-3 py-1.5 hover:bg-black/5 dark:hover:bg-white/10">Выбирать автоматически</button>
          <button type="button" onClick={() => onCoverPick(false)} className="rounded-lg px-3 py-1.5 hover:bg-black/5 dark:hover:bg-white/10">Отмена</button>
        </div>
      )}
      {merging && (
        <div className="mt-3 glass rounded-xl p-3">
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
