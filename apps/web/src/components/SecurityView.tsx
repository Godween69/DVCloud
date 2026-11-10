import { Check, Copy, Download, KeyRound, Loader2, MessageCircle, ShieldAlert, ShieldCheck, Smartphone } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError } from '../api';
import type { Challenge, FactorStatus } from '../types';
import { ChallengePanel } from './ChallengePanel';
import { QrCode } from './QrCode';

const field =
  'mt-1.5 w-full rounded-lg border border-paper-300 bg-white/70 px-3.5 py-2.5 text-base text-gray-900 placeholder:text-gray-400 dark:border-white/10 dark:bg-white/5 dark:text-gray-100 dark:placeholder:text-gray-500';
const primary = 'flex items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-70';
const quiet = 'rounded-lg border border-paper-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-paper-200 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800';

function Card({ icon, title, note, children }: { icon: ReactNode; title: string; note: string; children: ReactNode }) {
  return (
    <section className="glass rounded-2xl p-5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-violet-600/10 text-violet-700 dark:text-violet-300" aria-hidden>{icon}</span>
        <div>
          <h2 className="font-semibold text-gray-900 dark:text-white">{title}</h2>
          <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">{note}</p>
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

// Пароль (а если включены коды из приложения, то и код) перед опасным действием.
function Confirm({ needCode, label, onSubmit, onCancel }: { needCode: boolean; label: string; onSubmit: (password: string, code?: string) => Promise<void>; onCancel: () => void }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(password, needCode ? code.trim() : undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не получилось');
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="max-w-sm">
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
        Ваш пароль
        <input className={field} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required autoFocus />
      </label>
      {needCode && (
        <label className="mt-3 block text-sm font-medium text-gray-700 dark:text-gray-300">
          Код из приложения или запасной код
          <input className={field} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" autoCorrect="off" spellCheck={false} required />
        </label>
      )}
      {error && <p role="alert" className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">{error}</p>}
      <div className="mt-4 flex gap-2">
        <button type="submit" disabled={busy} className={primary}>{busy && <Loader2 className="size-4 animate-spin" aria-hidden />}{label}</button>
        <button type="button" onClick={onCancel} className={quiet}>Отмена</button>
      </div>
    </form>
  );
}

// Запасные коды показываются один раз: их надо сохранить сразу.
function RecoveryCodes({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = codes.join('\n');
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); } catch { /* буфер недоступен, остаётся «Скачать» */ }
  }
  function save() {
    const url = URL.createObjectURL(new Blob([`Запасные коды DV Cloud (каждый работает один раз)\n\n${text}\n`], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dvcloud-zapasnye-kody.txt';
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
      <p className="text-sm font-medium text-amber-900 dark:text-amber-100">Сохраните запасные коды. Сервер больше их не покажет.</p>
      <p className="mt-1 text-sm text-amber-900/80 dark:text-amber-100/80">Каждый код работает один раз. Они нужны, если телефон потерян или DVChat недоступен.</p>
      <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm tabular-nums text-gray-900 sm:grid-cols-2 dark:text-gray-100" aria-label="Запасные коды">
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ul>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={copy} className={quiet}>{copied ? <span className="flex items-center gap-2"><Check className="size-4" aria-hidden />Скопировано</span> : <span className="flex items-center gap-2"><Copy className="size-4" aria-hidden />Скопировать</span>}</button>
        <button type="button" onClick={save} className={quiet}><span className="flex items-center gap-2"><Download className="size-4" aria-hidden />Скачать файл</span></button>
        <button type="button" onClick={onClose} className={primary}>Я сохранил(а)</button>
      </div>
    </div>
  );
}

export function SecurityView({ onError }: { onError: (m: string) => void }) {
  const [st, setSt] = useState<FactorStatus | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [flow, setFlow] = useState<'link' | 'unlink' | 'totp' | 'totp-off' | 'new-codes' | null>(null);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [totp, setTotp] = useState<{ secret: string; uri: string } | null>(null);
  const [first, setFirst] = useState('');
  const [firstError, setFirstError] = useState<string | null>(null);

  const refresh = useCallback(() => { api.security().then(setSt).catch((e) => onError(e instanceof Error ? e.message : 'Не удалось загрузить')); }, [onError]);
  useEffect(refresh, [refresh]);

  const close = () => { setFlow(null); setChallenge(null); setTotp(null); setFirst(''); setFirstError(null); };
  const finish = (newCodes?: string[] | null) => { close(); if (newCodes && newCodes.length) setCodes(newCodes); refresh(); };

  if (!st) return <div className="flex justify-center py-24 text-gray-500"><Loader2 className="size-6 animate-spin" aria-label="Загрузка" /></div>;
  if (!st.available) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Безопасность</h1>
        <p className="mt-3 text-gray-600 dark:text-gray-400">Второй фактор входа не подключён на этом сервере.</p>
      </div>
    );
  }
  const needCode = !!st.totpEnabled;

  async function enableTotp(e: FormEvent) {
    e.preventDefault();
    setFirstError(null);
    try {
      const r = await api.totpEnable(first.trim());
      finish(r.recoveryCodes);
    } catch (err) {
      setFirstError(err instanceof ApiError ? err.message : 'Не получилось');
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Безопасность</h1>
      <p className={`mt-3 flex items-center gap-2 text-sm font-medium ${st.enabled ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-800 dark:text-amber-200'}`} role="status">
        {st.enabled ? <ShieldCheck className="size-5" aria-hidden /> : <ShieldAlert className="size-5" aria-hidden />}
        {st.enabled ? 'Вход защищён вторым фактором' : 'Второй фактор выключен: вход только по паролю'}
      </p>

      <div className="mt-6 space-y-4">
        {codes && <RecoveryCodes codes={codes} onClose={() => setCodes(null)} />}

        <Card icon={<MessageCircle className="size-5" />} title="Подтверждение в DVChat" note="Основной способ. При входе покажем QR-код, вы сканируете его в приложении и вводите число.">
          {!st.chatAvailable ? (
            <p className="text-sm text-gray-600 dark:text-gray-400">Не настроено на сервере.</p>
          ) : flow === 'link' ? (
            challenge ? (
              <ChallengePanel challenge={challenge} intro="В приложении DVChat откройте сканер и наведите на код." poll={async () => {
                const r = await api.chatLinkStatus();
                if (r.state === 'approved') { finish(r.recoveryCodes); return 'done'; }
                return r.state === 'failed' ? 'failed' : 'pending';
              }} onDone={() => {}} onRetry={() => setChallenge(null)} />
            ) : (
              <Confirm needCode={needCode} label="Показать QR-код" onCancel={close} onSubmit={async (p, c) => setChallenge(await api.chatLinkStart(p, c))} />
            )
          ) : flow === 'unlink' ? (
            <Confirm needCode={needCode} label="Отвязать" onCancel={close} onSubmit={async (p, c) => { await api.chatUnlink(p, c); finish(); }} />
          ) : st.chatLinked ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-gray-800 dark:text-gray-200">Привязан: <span className="font-mono">{st.matrixId}</span></p>
              <button type="button" onClick={() => setFlow('unlink')} className={quiet}>Отвязать</button>
            </div>
          ) : (
            <button type="button" onClick={() => setFlow('link')} className={primary}><Smartphone className="size-4" aria-hidden />Привязать DVChat</button>
          )}
        </Card>

        <Card icon={<KeyRound className="size-5" />} title="Коды из приложения" note="Запасной способ: Google Authenticator, Aegis, 2FAS и подобные. Работает без DVChat.">
          {!st.totpAvailable ? (
            <p className="text-sm text-gray-600 dark:text-gray-400">Не настроено на сервере.</p>
          ) : flow === 'totp' ? (
            totp ? (
              <form onSubmit={enableTotp} className="max-w-sm">
                <p className="text-sm text-gray-600 dark:text-gray-400">Отсканируйте код в приложении-аутентификаторе, затем введите шестизначный код оттуда.</p>
                <div className="mt-3 flex justify-center"><QrCode value={totp.uri} label="QR-код для приложения-аутентификатора" size={176} /></div>
                <p className="mt-3 text-sm text-gray-600 dark:text-gray-400">Не получается сканировать? Введите ключ вручную:</p>
                <p className="mt-1 break-all rounded-lg bg-paper-200 px-3 py-2 font-mono text-sm tracking-wider text-gray-900 dark:bg-gray-800 dark:text-gray-100">{totp.secret.replace(/(.{4})/g, '$1 ').trim()}</p>
                <label className="mt-4 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Код из приложения
                  <input className={field} value={first} onChange={(e) => setFirst(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="\d{6}" placeholder="123456" required autoFocus />
                </label>
                {firstError && <p role="alert" className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">{firstError}</p>}
                <div className="mt-4 flex gap-2"><button type="submit" className={primary}>Включить</button><button type="button" onClick={close} className={quiet}>Отмена</button></div>
              </form>
            ) : (
              <Confirm needCode={false} label="Продолжить" onCancel={close} onSubmit={async (p) => setTotp(await api.totpBegin(p))} />
            )
          ) : flow === 'totp-off' ? (
            <Confirm needCode={needCode} label="Выключить" onCancel={close} onSubmit={async (p, c) => { await api.totpDisable(p, c); finish(); }} />
          ) : st.totpEnabled ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-gray-800 dark:text-gray-200">Включены</p>
              <button type="button" onClick={() => setFlow('totp-off')} className={quiet}>Выключить</button>
            </div>
          ) : (
            <button type="button" onClick={() => setFlow('totp')} className={primary}>Включить коды из приложения</button>
          )}
        </Card>

        {st.enabled && (
          <Card icon={<KeyRound className="size-5" />} title="Запасные коды" note="Одноразовые коды на случай, если телефон потерян или DVChat недоступен.">
            {flow === 'new-codes' ? (
              <Confirm needCode={needCode} label="Выпустить новые" onCancel={close} onSubmit={async (p, c) => { const r = await api.recoveryNew(p, c); finish(r.recoveryCodes); }} />
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-sm text-gray-800 dark:text-gray-200">Осталось: {st.recoveryLeft ?? 0}</p>
                <button type="button" onClick={() => setFlow('new-codes')} className={quiet}>Выпустить новые</button>
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
