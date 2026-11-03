import { Loader2, Smartphone } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import type { Challenge } from '../types';
import { QrCode } from './QrCode';

interface Props {
  challenge: Challenge;
  // Опрос сервера: 'pending' = ждём, 'done' = подтверждено (панель вызывает onDone), 'failed' = запрос отменён.
  poll: () => Promise<'pending' | 'done' | 'failed'>;
  onDone: () => void;
  onRetry: () => void;
  intro: string;
}

// QR-код и число для подтверждения в DVChat. Страница сама спрашивает сервер раз в две секунды.
export function ChallengePanel({ challenge, poll, onDone, onRetry, intro }: Props) {
  const [left, setLeft] = useState(challenge.expiresIn);
  const [state, setState] = useState<'wait' | 'failed' | 'expired'>('wait');
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef(poll);
  const doneRef = useRef(onDone);
  pollRef.current = poll;
  doneRef.current = onDone;

  useEffect(() => {
    const end = Date.now() + challenge.expiresIn * 1000;
    let stop = false;
    const tick = setInterval(() => {
      const s = Math.max(0, Math.round((end - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) { stop = true; setState((st) => (st === 'wait' ? 'expired' : st)); }
    }, 500);
    const ask = setInterval(async () => {
      if (stop) return;
      try {
        const r = await pollRef.current();
        if (stop) return;
        if (r === 'done') { stop = true; doneRef.current(); }
        else if (r === 'failed') { stop = true; setState('failed'); }
      } catch (e) {
        stop = true;
        setError(e instanceof ApiError ? e.message : 'Не удалось проверить подтверждение');
        setState('failed');
      }
    }, 2000);
    return () => { stop = true; clearInterval(tick); clearInterval(ask); };
  }, [challenge]);

  const mm = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;

  if (state !== 'wait') {
    return (
      <div className="text-center">
        <p role="alert" className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
          {error ?? (state === 'expired' ? 'Время вышло. Покажите код заново.' : 'Запрос отменён. Покажите код заново.')}
        </p>
        <button type="button" onClick={onRetry} className="mt-4 rounded-lg bg-violet-600 px-4 py-2.5 font-medium text-white transition-colors hover:bg-violet-500">Показать новый код</button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center text-center">
      <p className="text-sm text-gray-600 dark:text-gray-400">{intro}</p>
      <div className="mt-4"><QrCode value={challenge.qr} label="QR-код для подтверждения в DVChat" /></div>
      <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">Приложение попросит ввести число:</p>
      <p className="mt-1 text-4xl font-semibold tabular-nums tracking-[0.3em] text-gray-900 dark:text-white" aria-label={`Число для ввода: ${challenge.number.split('').join(' ')}`}>{challenge.number}</p>
      <p className="mt-3 flex items-center gap-2 text-sm text-gray-500" aria-live="off">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Ждём подтверждения · {mm}
      </p>
      {/* На телефоне QR самому себе не показать: кнопка открывает DVChat прямо по ссылке. */}
      <a href={challenge.qr} className="mt-4 inline-flex items-center gap-2 rounded-lg border border-paper-300 px-3.5 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-paper-200 sm:hidden dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800">
        <Smartphone className="size-4" aria-hidden /> Открыть в DVChat
      </a>
    </div>
  );
}
