import { Check, Loader2, UserMinus } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { api, ApiError } from '../api';
import { boxRect, faceLabel, sameName, suggest, type Rect } from '../lib/people';
import type { View } from '../lib/zoom';
import type { FaceBox, PeopleGroup } from '../types';

interface Props {
  fileId: string;
  img: RefObject<HTMLImageElement | null>;
  stage: RefObject<HTMLDivElement | null>;
  view: View; // масштаб и сдвиг: рамки пересчитываются вместе с фото
  tick: number; // растёт, когда фото загрузилось или поменяло размер
  groups: PeopleGroup[];
  onChanged: () => void; // группы изменились (новый человек, новое имя)
  onError: (m: string) => void;
}

// Рамки лиц и питомцев поверх фото. Нажатие на рамку открывает окошко: назвать, выбрать из знакомых или сказать «это не он».
export function FaceLayer({ fileId, img, stage, view, tick, groups, onChanged, onError }: Props) {
  const [faces, setFaces] = useState<FaceBox[]>([]);
  const [rects, setRects] = useState<Record<string, Rect>>({});
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  const [open, setOpen] = useState<string | null>(null);
  const gen = useRef(0);

  const load = useCallback(() => {
    const my = ++gen.current;
    api.facesOf(fileId).then((f) => { if (my === gen.current) setFaces(f); }).catch(() => { if (my === gen.current) setFaces([]); });
  }, [fileId]);
  useEffect(() => { setFaces([]); setOpen(null); load(); }, [load]);

  const measure = useCallback(() => {
    const i = img.current?.getBoundingClientRect();
    const s = stage.current?.getBoundingClientRect();
    if (!i || !s) return;
    const r: Record<string, Rect> = {};
    for (const f of faces) r[f.id] = boxRect(f.box, i, s);
    setRects(r);
    setStageSize({ w: s.width, h: s.height });
  }, [faces, img, stage]);
  useLayoutEffect(() => { measure(); }, [measure, view, tick]);
  useEffect(() => {
    // фото появляется с лёгким увеличением: после него рамки встают точно
    const t = setTimeout(measure, 250);
    window.addEventListener('resize', measure);
    return () => { clearTimeout(t); window.removeEventListener('resize', measure); };
  }, [measure]);

  const cur = faces.find((f) => f.id === open) ?? null;

  return (
    <div className="pointer-events-none absolute inset-0 z-[5]" data-testid="face-layer">
      {faces.map((f) => {
        const r = rects[f.id];
        if (!r) return null;
        const on = open === f.id;
        return (
          <button key={f.id} type="button" onClick={(e) => { e.stopPropagation(); setOpen(on ? null : f.id); }} aria-label={faceLabel(f)} aria-expanded={on}
            style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
            className={`pointer-events-auto absolute rounded-md border-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-white ${on ? 'border-violet-400 bg-violet-400/20' : f.name ? 'border-white/80 hover:border-violet-300' : 'border-white/40 border-dashed hover:border-violet-300'}`}>
            <span className={`absolute left-1/2 top-full mt-1 max-w-40 -translate-x-1/2 truncate whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium ${f.name ? 'bg-black/70 text-white' : 'bg-black/50 text-white/80'}`}>{faceLabel(f)}</span>
          </button>
        );
      })}
      {cur && rects[cur.id] && (
        <NamePopover key={cur.id} face={cur} rect={rects[cur.id]} stageW={stageSize.w} stageH={stageSize.h} groups={groups} fileId={fileId}
          onClose={() => setOpen(null)} onDone={() => { setOpen(null); load(); onChanged(); }} onError={onError} />
      )}
    </div>
  );
}

function NamePopover({ face, rect, stageW, stageH, groups, fileId, onClose, onDone, onError }: {
  face: FaceBox; rect: Rect; stageW: number; stageH: number; groups: PeopleGroup[]; fileId: string;
  onClose: () => void; onDone: () => void; onError: (m: string) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const W = 260;
  const left = Math.max(8, Math.min(rect.left, stageW - W - 8));
  const below = rect.top + rect.height + 36 + 220 < stageH;
  const pos = below ? { top: rect.top + rect.height + 36 } : { bottom: Math.max(8, stageH - rect.top + 8) };
  const hints = suggest(groups, text, face.kind).filter((p) => p.id !== face.personId);
  const existing = sameName(groups, text, face.kind);

  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try { await fn(); onDone(); } catch (e) { onError(e instanceof ApiError ? e.message : 'Не получилось'); setBusy(false); }
  }
  const pick = (p: PeopleGroup) => run(async () => { await api.assignFace(face.id, p.id); });
  const submit = () => {
    const v = text.trim();
    if (!v) return;
    return run(async () => { if (existing) await api.assignFace(face.id, existing.id); else await api.createPerson(face.id, v); });
  };
  const notThem = () => run(async () => { if (face.personId) await api.removeFromPerson(face.personId, fileId); });

  return (
    <div role="dialog" aria-label="Кто это" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} style={{ left, width: W, ...pos }}
      className="pointer-events-auto absolute max-h-[60%] overflow-y-auto rounded-xl border border-white/15 bg-gray-900/95 p-3 text-white shadow-[0_0_30px_-6px_rgba(0,0,0,0.6)] backdrop-blur">
      <p className="mb-2 text-sm text-white/70">{face.name ? `Сейчас: ${face.name}` : face.kind === 'face' ? 'Кто это?' : face.kind === 'cat' ? 'Как зовут кота?' : 'Как зовут собаку?'}</p>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="flex gap-2">
        <input autoFocus value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }} maxLength={60} autoComplete="off" aria-label="Имя"
          placeholder={face.name ? 'Другое имя' : 'Имя'} className="min-w-0 flex-1 rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-sm text-white outline-none placeholder:text-white/40 focus:border-violet-400" />
        <button type="submit" disabled={busy || !text.trim()} aria-label="Сохранить" className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50">
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Check className="size-4" aria-hidden />}
        </button>
      </form>
      {hints.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {hints.map((p) => (
            <li key={p.id}><button type="button" disabled={busy} onClick={() => void pick(p)} className="rounded-full bg-white/10 px-3 py-1 text-sm hover:bg-white/20 disabled:opacity-50">{p.name}</button></li>
          ))}
        </ul>
      )}
      {text.trim() && <p className="mt-2 text-xs text-white/50">{existing ? `Это «${existing.name}», уже знакомый.` : `Новый человек: «${text.trim()}».`}</p>}
      {face.personId && (
        <button type="button" disabled={busy} onClick={() => void notThem()} className="mt-3 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-white/80 hover:bg-white/10 disabled:opacity-50">
          <UserMinus className="size-4" aria-hidden />Это не {face.name ?? 'он'}
        </button>
      )}
    </div>
  );
}
