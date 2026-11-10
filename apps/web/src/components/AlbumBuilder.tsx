import { CalendarRange, Check, Film, Folders, Images, Loader2, Minus, Plus, ScanFace, Smartphone, X } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { WheelDate } from './WheelDate';
import { Switch } from './ui';
import { api, ApiError, cropUrl, type BuilderQuery } from '../api';
import type { Album, PeopleGroup } from '../types';
import { iso, showDate } from '../lib/dates';

type Source = BuilderQuery['source'];
const SOURCES: { id: Source; label: string; icon: typeof Images }[] = [
  { id: 'all', label: 'Всё', icon: Images },
  { id: 'photos', label: 'Фото', icon: Images },
  { id: 'videos', label: 'Видео', icon: Film },
  { id: 'screenshots', label: 'Скриншоты', icon: Smartphone },
  { id: 'albums', label: 'Из альбомов', icon: Folders },
];

const files = (n: number) => { const m = n % 100, r = n % 10; return `${n} ${m > 10 && m < 15 ? 'файлов' : r === 1 ? 'файл' : r >= 2 && r <= 4 ? 'файла' : 'файлов'}`; };

interface Props {
  albums: Album[];
  onClose: () => void;
  onCreated: (a: Album) => void;
  onError: (m: string) => void;
}

// Конструктор альбома: период, откуда брать, кто должен (и кого не должно) быть на фото. Сверху живой счётчик подходящих файлов.
export function AlbumBuilder({ albums, onClose, onCreated, onError }: Props) {
  const [bounds, setBounds] = useState<{ min: string | null; max: string } | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [source, setSource] = useState<Source>('all');
  const [albumIds, setAlbumIds] = useState<string[]>([]);
  const [people, setPeople] = useState<PeopleGroup[] | null>(null);
  const [state, setState] = useState<Record<string, 'in' | 'out'>>({});
  const [only, setOnly] = useState(false); // «только они»: других лиц на фото нет
  const [name, setName] = useState('');
  const [count, setCount] = useState<number | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.builderBounds().then(setBounds).catch(() => setBounds({ min: null, max: iso(new Date()) }));
    api.peopleGroups().then((l) => setPeople(l.people.filter((p) => p.name))).catch(() => setPeople([]));
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const query = useMemo<BuilderQuery>(() => ({
    from: from || undefined, to: to || undefined, source, albumIds: source === 'albums' ? albumIds : [],
    include: Object.keys(state).filter((k) => state[k] === 'in'), exclude: Object.keys(state).filter((k) => state[k] === 'out'),
    only: only && Object.values(state).includes('in') ? true : undefined,
  }), [from, to, source, albumIds, state, only]);
  const incomplete = source === 'albums' && albumIds.length === 0;
  const badRange = !!from && !!to && from > to;

  // Живой счётчик с небольшой задержкой, чтобы не бить по серверу на каждый символ.
  useEffect(() => {
    if (incomplete || badRange) { setCount(null); setProblem(badRange ? 'Дата «с» позже даты «по»' : ''); return; }
    setProblem('');
    let live = true;
    const t = setTimeout(() => {
      api.builderCount(query).then((n) => { if (live) setCount(n); }).catch((e) => { if (live) { setCount(null); setProblem(e instanceof ApiError ? e.message : 'Не получилось посчитать'); } });
    }, 600); // как в живом поиске: считаем, когда вы перестали крутить
    return () => { live = false; clearTimeout(t); };
  }, [query, incomplete, badRange]);

  const own = albums.filter((a) => a.mine);
  const cycle = (id: string) => setState((s) => { const n = { ...s }; if (!n[id]) n[id] = 'in'; else if (n[id] === 'in') n[id] = 'out'; else delete n[id]; return n; });
  const preset = (f: string, t: string) => { setFrom(f); setTo(t); };
  const today = bounds?.max ?? iso(new Date());
  const year = today.slice(0, 4);
  const ago = (days: number) => { const d = new Date(today + 'T12:00:00'); d.setDate(d.getDate() - days); return iso(d); };
  const presets = [
    { label: 'Всё время', from: '', to: '' },
    { label: '30 дней', from: ago(30), to: today },
    { label: 'Этот год', from: `${year}-01-01`, to: today },
    { label: 'Прошлый год', from: `${Number(year) - 1}-01-01`, to: `${Number(year) - 1}-12-31` },
  ];

  // Резюме периода собирается из текущих «с» и «по» при каждой отрисовке, поэтому всегда актуально.
  const summary = !from && !to ? 'Период: за всё время' : `Период: ${from ? `с ${showDate(from)}` : 'с самого начала'} ${to ? `по ${showDate(to)}` : 'по сегодня'}`;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !name.trim() || !count) return;
    setBusy(true);
    try {
      const r = await api.builderCreate({ ...query, name: name.trim() });
      onCreated(r.album);
      onClose();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Не получилось создать альбом');
    } finally { setBusy(false); }
  }

  const chip = 'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors';
  const idle = 'border-paper-300/80 bg-white/40 text-gray-800 hover:bg-white/70 dark:border-white/15 dark:bg-white/5 dark:text-gray-200 dark:hover:bg-white/10';
  const on = 'border-violet-400 bg-violet-600 text-white shadow-[0_0_16px_-4px_rgba(139,92,246,0.8)]';
  const dateInput = 'rounded-lg border border-paper-300 bg-white/70 px-3 py-2 text-sm outline-none focus:border-violet-500 dark:border-gray-700 dark:bg-gray-900/60 dark:text-white';

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form onSubmit={submit} role="dialog" aria-modal="true" aria-label="Новый альбом по условиям" className="glass-strong flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl text-gray-900 sm:rounded-3xl dark:text-white">
        <header className="flex items-center justify-between px-5 pb-2 pt-4">
          <h3 className="text-lg font-semibold">Новый альбом по условиям</h3>
          <button type="button" onClick={onClose} aria-label="Закрыть" className="grid size-9 place-items-center rounded-full hover:bg-black/5 dark:hover:bg-white/10"><X className="size-5" aria-hidden /></button>
        </header>
        <div className="space-y-5 overflow-y-auto px-5 pb-4">
          <section aria-label="Период">
            <p className="mb-2 flex items-center gap-1.5 text-sm font-medium"><CalendarRange className="size-4" aria-hidden />За какой период</p>
            <div className="flex flex-wrap items-center gap-2">
              <WheelDate label="с" value={from} min={bounds?.min ?? '2000-01-01'} max={today} start={bounds?.min ?? today} onChange={setFrom} />
              <WheelDate label="по" value={to} min={bounds?.min ?? '2000-01-01'} max={today} start={today} onChange={setTo} />
              {(from || to) && <button type="button" onClick={() => preset('', '')} className="rounded-lg px-2 py-1 text-sm text-gray-600 hover:bg-black/5 dark:text-gray-400 dark:hover:bg-white/10">Сбросить</button>}
            </div>
            <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Быстрый выбор периода">
              {presets.map((p) => <button key={p.label} type="button" aria-pressed={from === p.from && to === p.to} onClick={() => preset(p.from, p.to)} className={`${chip} ${from === p.from && to === p.to ? on : idle}`}>{p.label}</button>)}
            </div>
            {from && !to && <p className="mt-1.5 text-xs text-gray-600 dark:text-gray-400">«По» не выбрано: берём до сегодняшнего дня.</p>}
            <p className="mt-2 text-sm text-gray-800 dark:text-gray-200" aria-live="polite">{summary}</p>
            {bounds?.min && <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">Ваши снимки: с {showDate(bounds.min)} по {showDate(bounds.max)}.</p>}
          </section>

          <section aria-label="Откуда брать">
            <p className="mb-2 text-sm font-medium">Откуда брать</p>
            <div className="flex flex-wrap gap-2">
              {SOURCES.map((s) => <button key={s.id} type="button" aria-pressed={source === s.id} onClick={() => setSource(s.id)} className={`${chip} ${source === s.id ? on : idle}`}><s.icon className="size-4" aria-hidden />{s.label}</button>)}
            </div>
            {source === 'albums' && (
              <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Альбомы">
                {own.length === 0 && <p className="text-sm text-gray-600 dark:text-gray-400">Своих альбомов пока нет.</p>}
                {own.map((a) => { const sel = albumIds.includes(a.id); return (
                  <button key={a.id} type="button" aria-pressed={sel} onClick={() => setAlbumIds((l) => (sel ? l.filter((x) => x !== a.id) : [...l, a.id]))} className={`${chip} ${sel ? on : idle}`}>{sel && <Check className="size-4" aria-hidden />}{a.name}</button>
                ); })}
              </div>
            )}
          </section>

          <section aria-label="Лица">
            <p className="mb-1 flex items-center gap-1.5 text-sm font-medium"><ScanFace className="size-4" aria-hidden />Кто на фото</p>
            <p className="mb-2 text-xs text-gray-600 dark:text-gray-400">Нажмите на человека: один раз — «должен быть», второй — «не должно быть», третий — не учитывать.</p>
            {people === null ? <Loader2 className="size-4 animate-spin" aria-label="Загружаем" /> : people.length === 0
              ? <p className="text-sm text-gray-600 dark:text-gray-400">Названных людей пока нет. Назовите их во вкладке «Люди».</p>
              : <div className="flex flex-wrap gap-2">
                {people.map((p) => { const st = state[p.id]; return (
                  <button key={p.id} type="button" onClick={() => cycle(p.id)} aria-label={`${p.name}: ${st === 'in' ? 'должен быть' : st === 'out' ? 'не должно быть' : 'не учитывать'}`}
                    className={`${chip} pl-1.5 ${st === 'in' ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-900 dark:text-emerald-100' : st === 'out' ? 'border-rose-500/40 bg-rose-500/15 text-rose-900 dark:text-rose-100' : idle}`}>
                    <img src={cropUrl(p.cover)} alt="" loading="lazy" draggable={false} className="size-6 rounded-full object-cover" />
                    {st === 'in' && <Plus className="size-4" aria-hidden />}{st === 'out' && <Minus className="size-4" aria-hidden />}{p.name}
                  </button>
                ); })}
              </div>}
            {people && people.length > 0 && (
              <div className="mt-3 flex items-center gap-3 text-sm">
                <Switch checked={only && Object.values(state).includes('in')} onChange={setOnly} label="Только выбранные: других лиц на фото нет" disabled={!Object.values(state).includes('in')} />
                <span className="text-gray-800 dark:text-gray-200">Только они: на фото больше никого, кроме «должен быть»</span>
              </div>
            )}
            <p className="mt-1.5 text-xs text-gray-600 dark:text-gray-400">Люди без отметки не учитываются: они могут быть на фото, а могут не быть.</p>
          </section>

          <section aria-label="Название">
            <label className="mb-2 block text-sm font-medium" htmlFor="ab-name">Название альбома</label>
            <input id="ab-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="Например, Лето 2026" className={`${dateInput} w-full`} />
          </section>
        </div>
        <footer className="flex items-center justify-between gap-3 border-t border-black/5 px-5 py-3 dark:border-white/10">
          <p className="min-w-0 text-sm" aria-live="polite">
            {problem ? <span className="text-rose-600 dark:text-rose-400">{problem}</span>
              : incomplete ? <span className="text-gray-600 dark:text-gray-400">Выберите хотя бы один альбом</span>
              : count === null ? <Loader2 className="size-4 animate-spin" aria-label="Считаем" />
              : <>Подходит: <b className="text-base">{files(count)}</b></>}
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-gray-700 hover:bg-black/5 dark:text-gray-300 dark:hover:bg-white/10">Отмена</button>
            <button type="submit" disabled={busy || !name.trim() || !count} className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-40">{busy && <Loader2 className="size-4 animate-spin" aria-hidden />}Создать альбом</button>
          </div>
        </footer>
      </form>
    </div>
  );
}
