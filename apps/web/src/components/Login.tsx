import { motion } from 'framer-motion';
import { Cloud, Loader2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import type { User } from '../types';
import { TwoFactorStep } from './TwoFactorStep';
import { Aurora } from './ui';

export function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<{ ticket: string; methods: string[] } | null>(null); // второй шаг входа

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.login(login.trim(), password);
      if ('user' in r) onLogin(r.user);
      else { setStep(r); setPassword(''); setBusy(false); }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось войти');
      setBusy(false);
    }
  }

  const field =
    'mt-1.5 w-full rounded-lg border border-paper-300 bg-white/70 px-3.5 py-2.5 text-base text-gray-900 placeholder:text-gray-400 dark:border-white/10 dark:bg-white/5 dark:text-gray-100 dark:placeholder:text-gray-500';

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4">
      <Aurora section="library" />
      <motion.main initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: 'easeOut' }} className="relative w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="mb-4 flex size-14 items-center justify-center rounded-2xl text-white" style={{ background: 'linear-gradient(135deg, var(--aur-a), var(--aur-b))', boxShadow: '0 12px 32px -10px var(--aur-a)' }}>
            <Cloud className="size-7" aria-hidden />
          </span>
          <h1 className="text-3xl font-semibold tracking-tight text-gray-900 dark:text-white">DV Cloud</h1>
          <p className="mt-1.5 text-gray-600 dark:text-gray-400">Семейный архив фото и видео</p>
        </div>
        {step ? <TwoFactorStep ticket={step.ticket} methods={step.methods} onLogin={onLogin} onCancel={() => setStep(null)} /> : (
        <form onSubmit={submit} className="glass-strong rounded-3xl p-6">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Логин
            <input className={field} value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required autoFocus />
          </label>
          <label className="mt-4 block text-sm font-medium text-gray-700 dark:text-gray-300">
            Пароль
            <input className={field} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          </label>
          {error && (
            <p role="alert" className="mt-4 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy} className="mt-6 flex w-full items-center justify-center gap-2 btn-accent rounded-lg px-4 py-2.5 font-medium text-white disabled:opacity-70">
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
            Войти
          </button>
        </form>
        )}
        <p className="mt-6 text-center text-sm text-gray-500">Аккаунты создаёт администратор. Если нет доступа, попросите его.</p>
      </motion.main>
    </div>
  );
}
