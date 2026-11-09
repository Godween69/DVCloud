import { Cloud, Loader2, Pause, Play, RefreshCw, Unplug } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { formatBytes } from '../lib/format';
import { etaText, importMode, percentDone, STATE_LABEL, yearLabel, yearsToSend } from '../lib/yandex';
import type { YandexItem, YandexItemState, YandexStatus } from '../types';

const primary = 'flex items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-70';
const quiet = 'flex items-center justify-center gap-2 rounded-lg border border-paper-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-paper-200 disabled:opacity-70 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800';
const card = 'rounded-2xl border border-paper-300 bg-paper-50 p-5 dark:border-gray-800 dark:bg-gray-900';
const muted = 'text-sm text-gray-600 dark:text-gray-400';

const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Что-то пошло не так. Попробуйте ещё раз.');

// Вход по QR: сервер просит у помощника страницу входа Яндекса, мы показываем QR, человек подтверждает вход в приложении на телефоне.
function Connect({ onDone, onError }: { onDone: () => void; onError: (m: string) => void }) {
  const [id, setId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  async function start() {
    setBusy(true);
    setNote(null);
    try {
      setId((await api.yandexConnect()).id);
    } catch (e) {
      onError(msg(e));
    } finally {
      setBusy(false);
    }
  }

  // Пока идёт вход: каждые 2 секунды спрашиваем итог, каждые 5 берём свежий QR (Яндекс обновляет его примерно раз в минуту).
  useEffect(() => {
    if (!id) return;
    let n = 0;
    const t = setInterval(async () => {
      n++;
      try {
        const st = await api.yandexConnectStatus(id);
        if (!alive.current) return;
        if (st.state === 'done') { clearInterval(t); setId(null); setQr(null); onDone(); return; }
        if (st.state === 'failed') { clearInterval(t); setId(null); setQr(null); setNote(st.note || 'Вход не удался или время вышло. Начните заново.'); return; }
        if (n % 2 === 1 || !qr) {
          const url = await api.yandexQr(id);
          if (alive.current && url) setQr((old) => { if (old) URL.revokeObjectURL(old); return url; });
        }
      } catch (e) {
        clearInterval(t);
        if (alive.current) { setId(null); setQr(null); onError(msg(e)); }
      }
    }, 2500);
    return () => clearInterval(t);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className={card}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-violet-600/10 text-violet-700 dark:text-violet-300" aria-hidden><Cloud className="size-5" /></span>
        <div>
          <h2 className="font-semibold text-gray-900 dark:text-white">Подключить Яндекс Диск</h2>
          <p className={`${muted} mt-0.5`}>Войдите в свой аккаунт Яндекса по QR-коду с телефона. Пароль Яндекса сюда не вводится. DV Cloud только читает ваши файлы из безлимита и ничего не меняет и не удаляет на Диске.</p>
        </div>
      </div>
      {id ? (
        <div className="mt-4 flex flex-col items-start gap-3">
          {qr ? <img src={qr} alt="QR-код для входа в Яндекс" className="size-56 rounded-lg bg-white p-2" /> : <div className="flex size-56 items-center justify-center rounded-lg border border-paper-300 dark:border-gray-700"><Loader2 className="size-6 animate-spin text-gray-400" aria-label="Готовим QR-код" /></div>}
          <p className={muted}>Откройте приложение Яндекс на телефоне, где вы уже вошли, наведите камеру на QR-код и подтвердите вход. Код обновляется сам.</p>
        </div>
      ) : (
        <div className="mt-4">
          {note && <p role="alert" className="mb-3 text-sm text-red-600 dark:text-red-400">{note}</p>}
          <button type="button" className={primary} onClick={start} disabled={busy}>{busy && <Loader2 className="size-4 animate-spin" />}Показать QR-код</button>
        </div>
      )}
    </section>
  );
}

function Items({ onError }: { onError: (m: string) => void }) {
  const [filter, setFilter] = useState<YandexItemState | ''>('failed');
  const [data, setData] = useState<{ items: YandexItem[]; total: number } | null>(null);
  useEffect(() => {
    api.yandexItems(filter || null, 0).then(setData).catch((e) => onError(msg(e)));
  }, [filter, onError]);
  return (
    <section className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold text-gray-900 dark:text-white">Файлы</h2>
        <select value={filter} onChange={(e) => setFilter(e.target.value as YandexItemState | '')} aria-label="Показать файлы" className="rounded-lg border border-paper-300 bg-paper-50 px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100">
          <option value="">Все</option>
          {(Object.keys(STATE_LABEL) as YandexItemState[]).map((k) => <option key={k} value={k}>{STATE_LABEL[k]}</option>)}
        </select>
      </div>
      {!data ? <Loader2 className="mt-4 size-5 animate-spin text-gray-400" aria-label="Загрузка" /> : data.items.length === 0 ? <p className={`${muted} mt-3`}>Здесь пока пусто.</p> : (
        <ul className="mt-3 divide-y divide-paper-300 dark:divide-gray-800">
          {data.items.map((it, i) => (
            <li key={i} className="flex flex-wrap items-baseline justify-between gap-x-4 py-2 text-sm">
              <span className="min-w-0 break-all text-gray-900 dark:text-gray-100">{it.name}</span>
              <span className={muted}>{formatBytes(it.size)} · {STATE_LABEL[it.state]}</span>
              {it.error && <span className="w-full text-xs text-red-600 dark:text-red-400">{it.error}</span>}
            </li>
          ))}
        </ul>
      )}
      {data && data.total > data.items.length && <p className={`${muted} mt-2`}>Показаны первые {data.items.length} из {data.total}.</p>}
    </section>
  );
}

export function YandexView({ onError }: { onError: (m: string) => void }) {
  const [st, setSt] = useState<YandexStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Set<number | null>>(new Set());
  const [intoAlbum, setIntoAlbum] = useState(true);
  const [confirmOff, setConfirmOff] = useState(false);

  const load = useCallback(() => api.yandexStatus().then(setSt).catch((e) => onError(msg(e))), [onError]);
  useEffect(() => { load(); }, [load]);
  // Пока что-то идёт, обновляем каждые 3 секунды; в покое раз в минуту.
  const active = st?.list?.state === 'running' || st?.import?.state === 'running';
  useEffect(() => {
    const t = setInterval(load, active ? 3000 : 60000);
    return () => clearInterval(t);
  }, [load, active]);

  async function act(f: () => Promise<unknown>) {
    setBusy(true);
    try { await f(); await load(); } catch (e) { onError(msg(e)); } finally { setBusy(false); }
  }

  if (!st) return <div className="mx-auto max-w-3xl p-6"><Loader2 className="size-6 animate-spin text-gray-400" aria-label="Загрузка" /></div>;
  if (!st.enabled) return <div className="mx-auto max-w-3xl p-6"><p className={muted}>Яндекс Диск не включён на этом сервере.</p></div>;
  if (!st.connected) return <div className="mx-auto max-w-3xl space-y-4 p-6"><Connect onDone={load} onError={onError} /></div>;

  const mode = importMode(st);
  const years = st.years ?? [];
  const allYears = years.map((y) => y.year);
  const c = st.counts;
  const total = c ? c.new + c.queued + c.done + c.waiting + c.failed + c.skipped : 0;
  const pct = percentDone(st);

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      {st.state === 'expired' ? (
        <div className="space-y-4">
          <p role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">Яндекс закрыл сессию. Подключите Диск заново: уже забранные файлы остаются, список и очередь сохранятся.</p>
          <Connect onDone={load} onError={onError} />
        </div>
      ) : (
        <>
          <section className={card}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold text-gray-900 dark:text-white">Безлимит Яндекс Диска</h2>
                <p className={`${muted} mt-0.5`}>{total > 0 ? `${total} файлов, ${formatBytes(st.bytes?.total ?? 0)}.` : 'Список файлов ещё не прочитан.'}{st.list?.at ? ` Список обновлён ${new Date(st.list.at).toLocaleString('ru-RU')}.` : ''}</p>
                {st.list?.state === 'error' && <p role="alert" className="mt-1 text-sm text-red-600 dark:text-red-400">{st.list.note}</p>}
              </div>
              <button type="button" className={quiet} disabled={busy || st.list?.state === 'running'} onClick={() => act(() => api.yandexList())}>
                {st.list?.state === 'running' ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}{total > 0 ? 'Обновить список' : 'Прочитать список'}
              </button>
            </div>

            {c && total > 0 && (
              <p className={`${muted} mt-3`}>Забрано {c.done}, осталось {c.new + c.queued}{c.waiting > 0 ? `, ждут Яндекс ${c.waiting}` : ''}{c.failed > 0 ? `, не получилось ${c.failed}` : ''}{c.skipped > 0 ? `, пропущено ${c.skipped} (не фото и не видео)` : ''}.</p>
            )}

            {mode === 'ready' && years.length > 0 && (
              <fieldset className="mt-4">
                <legend className="text-sm font-medium text-gray-900 dark:text-white">Какие годы забрать (ничего не отмечено: все)</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {years.map((y) => (
                    <label key={String(y.year)} className="flex items-center gap-1.5 rounded-lg border border-paper-300 px-3 py-1.5 text-sm dark:border-gray-700">
                      <input type="checkbox" checked={picked.has(y.year)} onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(y.year); else n.delete(y.year); return n; })} />
                      {yearLabel(y.year)} <span className={muted}>{y.todo} · {formatBytes(y.bytes)}</span>
                    </label>
                  ))}
                </div>
                <label className="mt-3 flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
                  <input type="checkbox" checked={intoAlbum} onChange={(e) => setIntoAlbum(e.target.checked)} /> Собрать забранное в альбом «Яндекс Диск»
                </label>
              </fieldset>
            )}

            {st.quota && !st.quota.fits && st.quota.freeBytes !== null && (
              <p role="alert" className="mt-3 text-sm text-amber-800 dark:text-amber-300">Не хватит места: нужно ещё {formatBytes(st.quota.needBytes)}, свободно {formatBytes(st.quota.freeBytes)}. Одинаковые файлы, которые уже есть в облаке, места не занимают.</p>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              {mode === 'ready' && <button type="button" className={primary} disabled={busy} onClick={() => act(() => api.yandexImport({ years: yearsToSend(allYears, picked), intoAlbum }))}><Play className="size-4" />Забрать в DV Cloud</button>}
              {mode === 'running' && <button type="button" className={quiet} disabled={busy} onClick={() => act(() => api.yandexPause())}><Pause className="size-4" />Приостановить</button>}
              {mode === 'paused' && <button type="button" className={primary} disabled={busy} onClick={() => act(() => api.yandexResume())}><Play className="size-4" />Продолжить</button>}
              {(c?.failed ?? 0) > 0 && mode !== 'running' && <button type="button" className={quiet} disabled={busy} onClick={() => act(() => api.yandexImport({ retryFailed: true }))}>Повторить неудачные</button>}
              {mode === 'nothing' && total > 0 && <span className={muted}>Всё забрано.</span>}
            </div>

            {st.import?.note && <p className={`${muted} mt-2`}>{st.import.note}</p>}
            {(mode === 'running' || mode === 'paused') && (
              <div className="mt-4">
                <div className="h-2 overflow-hidden rounded-full bg-paper-200 dark:bg-gray-800" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Ход забора файлов">
                  <div className="h-full bg-violet-600 transition-[width]" style={{ width: `${pct}%` }} />
                </div>
                <p className={`${muted} mt-1`}>
                  {pct}%{st.import?.speed ? `, ${formatBytes(st.import.speed)}/с` : ''}{st.import?.etaSec != null ? `, осталось около ${etaText(st.import.etaSec)}` : ''}
                  {st.import?.current ? `. Сейчас: ${st.import.current.name} (${formatBytes(st.import.current.got)} из ${formatBytes(st.import.current.size)})` : ''}
                </p>
              </div>
            )}
          </section>

          {total > 0 && <Items onError={onError} />}
        </>
      )}

      <section className={card}>
        {confirmOff ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className={muted}>Отключить Яндекс Диск? Забранные файлы останутся в DV Cloud, сохранённый вход будет удалён.</p>
            <button type="button" className={primary} disabled={busy} onClick={() => act(async () => { await api.yandexDisconnect(); setConfirmOff(false); })}>Отключить</button>
            <button type="button" className={quiet} onClick={() => setConfirmOff(false)}>Отмена</button>
          </div>
        ) : (
          <button type="button" className={quiet} onClick={() => setConfirmOff(true)}><Unplug className="size-4" />Отключить Яндекс Диск</button>
        )}
      </section>
    </div>
  );
}
