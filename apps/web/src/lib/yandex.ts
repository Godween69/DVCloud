// Чистые помощники вкладки «Яндекс Диск»: подписи, время, доля, выбор годов. Без сети и без React, поэтому проверяются тестами.
import type { YandexItemState, YandexStatus } from '../types';

// 3725 -> "1 ч 2 мин", 90 -> "2 мин", 20 -> "меньше минуты"
export function etaText(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec) || sec < 0) return '';
  if (sec < 60) return 'меньше минуты';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 48) return rest === 0 ? `${h} ч` : `${h} ч ${rest} мин`;
  return `${Math.round(h / 24)} дн`;
}

// Доля 0..100 для полосы хода; по байтам, а если размеров нет, по числу файлов.
export function percentDone(s: YandexStatus): number {
  const b = s.bytes;
  if (b && b.total > 0) return Math.min(100, Math.round((b.done / b.total) * 100));
  const c = s.counts;
  if (!c) return 0;
  const all = c.new + c.queued + c.done + c.waiting + c.failed + c.skipped;
  return all > 0 ? Math.round((c.done / all) * 100) : 0;
}

export const STATE_LABEL: Record<YandexItemState, string> = {
  new: 'ещё не забран',
  queued: 'в очереди',
  done: 'забран',
  waiting: 'ждёт Яндекс',
  failed: 'не получилось',
  skipped: 'пропущен',
};

// Подпись года; null значит «без даты».
export const yearLabel = (y: number | null): string => (y === null ? 'Без даты' : String(y));

// Что передать серверу: все годы выбраны (или ни одного) = забрать всё, иначе список выбранных.
export function yearsToSend(all: (number | null)[], picked: Set<number | null>): (number | null)[] | undefined {
  if (picked.size === 0 || picked.size === all.length) return undefined;
  return all.filter((y) => picked.has(y));
}

// Что показывать главной кнопкой в зависимости от состояния.
export function importMode(s: YandexStatus): 'running' | 'paused' | 'ready' | 'nothing' {
  if (s.import?.state === 'running') return 'running';
  if (s.import?.state === 'paused' && (s.counts?.queued ?? 0) + (s.counts?.waiting ?? 0) > 0) return 'paused';
  return (s.counts?.new ?? 0) + (s.counts?.failed ?? 0) > 0 ? 'ready' : 'nothing';
}
