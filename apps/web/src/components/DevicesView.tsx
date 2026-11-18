import { Loader2, Smartphone, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Device } from '../types';

const quiet = 'rounded-lg border border-paper-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-paper-200 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800';
const danger = 'rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-70';

function fmt(iso: string): string {
  try { return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
}

// Страница подключённых устройств: список токенов устройств с возможностью отзыва.
export function DevicesView({ onError }: { onError: (m: string) => void }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => { api.devices().then(setDevices).catch((e) => onError(e instanceof Error ? e.message : 'Не удалось загрузить')); }, [onError]);
  useEffect(refresh, [refresh]);

  async function revoke(id: string) {
    setBusy(true);
    try {
      await api.revokeDevice(id);
      setConfirmId(null);
      refresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Не получилось отозвать');
    } finally {
      setBusy(false);
    }
  }

  if (!devices) return <div className="flex justify-center py-24 text-gray-500"><Loader2 className="size-6 animate-spin" aria-label="Загрузка" /></div>;

  const active = devices.filter((d) => !d.revokedAt);
  const revoked = devices.filter((d) => d.revokedAt);

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Устройства</h1>
      <p className="mt-3 text-sm text-gray-600 dark:text-gray-400">
        Телефоны и планшеты, привязанные к аккаунту для фоновой выгрузки фото. Токен устройства бессрочный, но отзывается здесь, при выходе или смене пароля. Неактивные устройства отзываются автоматически.
      </p>

      {devices.length === 0 ? (
        <div className="mx-auto mt-10 flex max-w-md flex-col items-center text-center">
          <span className="mb-5 flex size-16 items-center justify-center rounded-2xl bg-paper-200 text-gray-500 dark:bg-gray-900"><Smartphone className="size-8" aria-hidden /></span>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Нет подключённых устройств</h2>
          <p className="mt-2 text-gray-600 dark:text-gray-400">Войдите в приложении DV Cloud на телефоне — он появится здесь и сможет выгружать фото в фоне.</p>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          {active.map((d) => (
            <section key={d.id} className="glass rounded-2xl p-5">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-violet-600/10 text-violet-700 dark:text-violet-300"><Smartphone className="size-5" aria-hidden /></span>
                <div className="min-w-0 flex-1">
                  <h2 className="font-semibold text-gray-900 dark:text-white">{d.deviceName}</h2>
                  <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">Привязано: {fmt(d.createdAt)}</p>
                  <p className="text-sm text-gray-600 dark:text-gray-400">Последний вход: {fmt(d.lastSeenAt)}{d.lastIp ? ` · ${d.lastIp}` : ''}</p>
                </div>
                <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">Активно</span>
              </div>
              <div className="mt-4">
                {confirmId === d.id ? (
                  <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4">
                    <p className="text-sm text-red-700 dark:text-red-300">Отозвать устройство? Оно перестанет выгружать фото, потребуется вход заново.</p>
                    <div className="mt-3 flex gap-2">
                      <button type="button" disabled={busy} onClick={() => revoke(d.id)} className={danger}>{busy ? 'Отзыв…' : 'Отозвать'}</button>
                      <button type="button" onClick={() => setConfirmId(null)} className={quiet}>Отмена</button>
                    </div>
                  </div>
                ) : (
                  <button type="button" onClick={() => setConfirmId(d.id)} className={quiet}><span className="flex items-center gap-2"><Trash2 className="size-4" aria-hidden />Отозвать</span></button>
                )}
              </div>
            </section>
          ))}
          {revoked.map((d) => (
            <section key={d.id} className="glass rounded-2xl p-5 opacity-60">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-paper-200 text-gray-500 dark:bg-gray-800"><Smartphone className="size-5" aria-hidden /></span>
                <div className="min-w-0 flex-1">
                  <h2 className="font-semibold text-gray-900 dark:text-white">{d.deviceName}</h2>
                  <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">Отозвано: {fmt(d.revokedAt!)}</p>
                </div>
                <span className="rounded-full bg-paper-200 px-2.5 py-1 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400">Отозвано</span>
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
