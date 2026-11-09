import { Check, Loader2, Sparkles, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, thumbUrl } from '../api';
import { formatBytes } from '../lib/format';
import type { SimilarGroup, SimilarResult } from '../types';

type Kind = 'duplicates' | 'series';

const TEXT: Record<Kind, { title: string; hint: string; empty: string }> = {
  duplicates: {
    title: 'Дубликаты',
    hint: 'Один и тот же снимок в разном качестве, например из мессенджера. Оставлен вариант с лучшим разрешением, остальные отмечены для удаления.',
    empty: 'Дубликатов не найдено.',
  },
  series: {
    title: 'Серии',
    hint: 'Кадры одного момента, снятые подряд. Отмечены лишние, лучшие (самые резкие) оставлены. Можно изменить отметки.',
    empty: 'Серий не найдено.',
  },
};

// Экран «Похожие»: группы снимков, предложение что убрать, удаление в корзину (с возможностью вернуть).
export function SimilarView({ onTrashed, onError }: { onTrashed: (ids: string[]) => void; onError: (m: string) => void }) {
  const [kind, setKind] = useState<Kind>('duplicates');
  const [data, setData] = useState<SimilarResult | null>(null);
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback((k: Kind) => {
    setData(null);
    api.similar(k).then((r) => {
      setData(r);
      setMarked(new Set(r.groups.flatMap((g) => g.files.filter((f) => f.suggestRemove).map((f) => f.id))));
    }).catch((e) => onError(e instanceof ApiError ? e.message : 'Не удалось загрузить'));
  }, [onError]);
  useEffect(() => { load(kind); }, [kind, load]);

  const total = marked.size;
  const bytes = useMemo(() => (data?.groups ?? []).flatMap((g) => g.files).filter((f) => marked.has(f.id)).reduce((s, f) => s + f.size, 0), [data, marked]);

  function toggle(id: string) {
    setMarked((m) => { const n = new Set(m); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  async function trashMarked() {
    if (!data || busy) return;
    setBusy(true);
    const done: string[] = [];
    // В группе всегда остаётся хотя бы один снимок: если отмечены все, последний не трогаем.
    const groups = data.groups.map((g) => ({ g, ids: g.files.filter((f) => marked.has(f.id)).map((f) => f.id) })).map(({ g, ids }) => ({ g, ids: ids.length === g.files.length ? ids.slice(1) : ids }));
    try {
      for (const { ids } of groups) for (const id of ids) { await api.trash(id); done.push(id); }
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Не получилось удалить');
    } finally {
      setBusy(false);
    }
    if (done.length) { onTrashed(done); load(kind); }
  }

  const progress = data && data.ready < data.images;
  return (
    <div className="mx-auto max-w-4xl px-3 pb-32 pt-6 sm:px-6">
      <h2 className="mb-1 text-2xl font-semibold tracking-tight text-gray-900 dark:text-white">Похожие</h2>
      <div className="mb-3 flex gap-2">
        {(['duplicates', 'series'] as const).map((k) => (
          <button key={k} type="button" onClick={() => setKind(k)} aria-pressed={kind === k} className={`rounded-lg px-3 py-1.5 text-sm font-medium ${kind === k ? 'bg-violet-600 text-white' : 'text-gray-600 hover:bg-paper-200 dark:text-gray-400 dark:hover:bg-gray-800'}`}>{TEXT[k].title}</button>
        ))}
      </div>
      <p className="mb-5 text-sm text-gray-600 dark:text-gray-400">{TEXT[kind].hint}</p>
      {progress && <p className="mb-4 flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300"><Sparkles className="size-4" aria-hidden /> Идёт подготовка: обработано {data!.ready} из {data!.images} фото. Результат будет полнее.</p>}
      {!data && <div className="flex justify-center py-20 text-gray-500"><Loader2 className="size-6 animate-spin" aria-label="Загружаем" /></div>}
      {data && data.groups.length === 0 && <p className="py-16 text-center text-gray-600 dark:text-gray-400">{TEXT[kind].empty}</p>}
      <ul className="space-y-4">
        {data?.groups.map((g: SimilarGroup) => (
          <li key={g.id} className="glass rounded-xl p-3">
            <ul className="flex gap-3 overflow-x-auto pb-1">
              {g.files.map((f, i) => (
                <li key={f.id} className="w-36 shrink-0">
                  <button type="button" onClick={() => toggle(f.id)} aria-pressed={marked.has(f.id)} aria-label={`${f.name}: ${marked.has(f.id) ? 'будет удалён' : 'останется'}`} className={`relative block overflow-hidden rounded-lg ring-2 ${marked.has(f.id) ? 'ring-red-500' : 'ring-transparent'}`}>
                    <img src={thumbUrl(f.id)} alt="" loading="lazy" className={`aspect-square w-full object-cover ${marked.has(f.id) ? 'opacity-50' : ''}`} />
                    <span className={`absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-full text-white ${marked.has(f.id) ? 'bg-red-600' : 'bg-emerald-600'}`}>{marked.has(f.id) ? <Trash2 className="size-3.5" aria-hidden /> : <Check className="size-3.5" aria-hidden />}</span>
                    {i === 0 && <span className="absolute bottom-1.5 left-1.5 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">лучший</span>}
                  </button>
                  <p className="mt-1 truncate text-xs text-gray-700 dark:text-gray-300">{f.name}</p>
                  <p className="text-xs text-gray-500">{f.width}×{f.height} · {formatBytes(f.size)}</p>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {total > 0 && (
        <div className="fixed inset-x-0 bottom-[3.75rem] z-30 sm:bottom-0 border-t border-paper-300 bg-paper-100/95 p-3 dark:border-gray-800 dark:bg-gray-950/95">
          <div className="mx-auto flex max-w-4xl items-center justify-between gap-3">
            <span className="text-sm text-gray-700 dark:text-gray-300">Отмечено: {total} ({formatBytes(bytes)}). Файлы уйдут в корзину, их можно вернуть.</span>
            <button type="button" disabled={busy} onClick={trashMarked} className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-60">
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Trash2 className="size-4" aria-hidden />} В корзину
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
