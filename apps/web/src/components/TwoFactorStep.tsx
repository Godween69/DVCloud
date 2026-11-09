import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import type { Challenge, User } from '../types';
import { ChallengePanel } from './ChallengePanel';

interface Props {
  ticket: string;
  methods: string[];
  onLogin: (u: User) => void;
  onCancel: () => void;
}

const field =
  'mt-1.5 w-full rounded-lg border border-paper-300 bg-white/70 px-3.5 py-2.5 text-base text-gray-900 placeholder:text-gray-400 dark:border-white/10 dark:bg-white/5 dark:text-gray-100 dark:placeholder:text-gray-500';

// Второй шаг входа: подтверждение в DVChat (основной способ) или код из приложения / запасной код.
export function TwoFactorStep({ ticket, methods, onLogin, onCancel }: Props) {
  const chat = methods.includes('chat');
  const codes = methods.includes('totp') || methods.includes('recovery');
  const [mode, setMode] = useState<'chat' | 'code'>(chat ? 'chat' : 'code');
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(0); // новый номер = показать новый QR

  useEffect(() => {
    if (mode !== 'chat') return;
    let alive = true;
    setChallenge(null);
    setError(null);
    api.chatStart(ticket).then((c) => { if (alive) setChallenge(c); }).catch((e) => {
      if (!alive) return;
      setError(e instanceof ApiError ? e.message : 'Не удалось запросить подтверждение');
      if (codes) setMode('code');
    });
    return () => { alive = false; };
  }, [mode, ticket, round, codes]);

  const poll = useCallback(async () => {
    const r = await api.chatStatus(ticket);
    if (r.state === 'approved' && r.user) { onLogin(r.user); return 'done' as const; }
    return r.state === 'failed' ? ('failed' as const) : ('pending' as const);
  }, [ticket, onLogin]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(await api.twoFactorCode(ticket, code.trim()));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось проверить код');
      setBusy(false);
    }
  }

  const link = 'text-sm font-medium text-violet-700 hover:text-violet-600 dark:text-violet-300 dark:hover:text-violet-200';

  return (
    <div className="glass-strong rounded-3xl p-6">
      <h2 className="text-center text-lg font-semibold text-gray-900 dark:text-white">Подтвердите вход</h2>
      {mode === 'chat' ? (
        <div className="mt-4">
          {error && <p role="alert" className="mb-4 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">{error}</p>}
          {challenge ? (
            <ChallengePanel challenge={challenge} poll={poll} onDone={() => {}} onRetry={() => setRound((n) => n + 1)} intro="В приложении DVChat откройте сканер и наведите на код." />
          ) : !error ? (
            <div className="flex justify-center py-16 text-gray-500"><Loader2 className="size-6 animate-spin" aria-label="Загрузка" /></div>
          ) : null}
          {codes && <p className="mt-5 text-center"><button type="button" onClick={() => setMode('code')} className={link}>Ввести код вручную</button></p>}
        </div>
      ) : (
        <form onSubmit={submit} className="mt-4">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Код из приложения-аутентификатора или запасной код
            <input className={field} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" inputMode="text" autoCapitalize="characters" autoCorrect="off" spellCheck={false} placeholder="123456 или XXXX-XXXX-XXXX" required autoFocus />
          </label>
          {error && <p role="alert" className="mt-4 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">{error}</p>}
          <button type="submit" disabled={busy} className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-70">
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
            Подтвердить
          </button>
          {chat && <p className="mt-5 text-center"><button type="button" onClick={() => setMode('chat')} className={link}>Подтвердить в DVChat</button></p>}
        </form>
      )}
      <p className="mt-5 text-center"><button type="button" onClick={onCancel} className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Назад</button></p>
    </div>
  );
}
