import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type { AlbumRef } from '../types';
import { parseTarget } from './quick-target';

const KEY = 'dvcloud.quickAlbum';
const KEY_ON = 'dvcloud.quickOn';

// Включён ли быстрый режим (альбом при выключении запоминается). По умолчанию включён.
function loadOn(): boolean {
  try {
    return localStorage.getItem(KEY_ON) !== '0';
  } catch {
    return true;
  }
}

function saveOn(on: boolean): void {
  try {
    localStorage.setItem(KEY_ON, on ? '1' : '0');
  } catch {
    /* не запомнится, ничего страшного */
  }
}

function load(): AlbumRef | null {
  try {
    return parseTarget(localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

function save(a: AlbumRef | null): void {
  try {
    if (a) localStorage.setItem(KEY, JSON.stringify(a));
    else localStorage.removeItem(KEY);
  } catch {
    /* не запомнится, ничего страшного */
  }
}

// «Быстрый альбом»: один раз выбрали альбом, дальше любое фото кладётся в него одним нажатием.
// Хранит номера файлов, которые в нём уже лежат, чтобы показывать галочку без запросов.
export function useQuickAlbum(say: (m: string) => void) {
  const [saved, setSaved] = useState<AlbumRef | null>(load);
  const [on, setOnState] = useState<boolean>(loadOn);
  const target = on ? saved : null; // действующий быстрый альбом: выбран и включён
  const [ids, setIds] = useState<Set<string>>(new Set());
  const gen = useRef(0);

  useEffect(() => {
    const my = ++gen.current;
    setIds(new Set());
    if (!target) return;
    api.albumIds(target.id).then((l) => { if (my === gen.current) setIds(new Set(l)); }).catch((e) => {
      if (my !== gen.current) return;
      if (e instanceof ApiError && e.status === 404) { save(null); setSaved(null); say('Быстрый альбом больше не существует, он выключен'); }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id]);

  // Выбрать альбом (и сразу включить режим) или забыть его (null).
  const set = useCallback((a: AlbumRef | null) => { save(a); setSaved(a); if (a) { saveOn(true); setOnState(true); } }, []);
  const setOn = useCallback((v: boolean) => { saveOn(v); setOnState(v); }, []);
  const has = useCallback((id: string) => ids.has(id), [ids]);

  // Нажатие на «+» у фото: положить, а если уже лежит, убрать. Возвращает true, если файл теперь в альбоме.
  const toggle = useCallback(async (id: string): Promise<boolean | null> => {
    if (!target) return null;
    const was = ids.has(id);
    setIds((s) => { const n = new Set(s); if (was) n.delete(id); else n.add(id); return n; });
    try {
      if (was) await api.albumRemoveFiles(target.id, [id]);
      else await api.albumAdd(target.id, [id]);
      return !was;
    } catch (e) {
      setIds((s) => { const n = new Set(s); if (was) n.add(id); else n.delete(id); return n; });
      say(e instanceof ApiError ? e.message : 'Не получилось');
      return null;
    }
  }, [target, ids, say]);

  const addMany = useCallback(async (list: string[]): Promise<number | null> => {
    if (!target) return null;
    try {
      const n = await api.albumAdd(target.id, list);
      setIds((s) => new Set([...s, ...list]));
      return n;
    } catch (e) {
      say(e instanceof ApiError ? e.message : 'Не получилось');
      return null;
    }
  }, [target, say]);

  // Файлы переехали другим способом (окно выбора альбома): подправить галочки.
  const note = useCallback((list: string[], albumId: string | null, removed = false) => {
    if (!target || albumId !== target.id) return;
    setIds((s) => { const n = new Set(s); for (const id of list) { if (removed) n.delete(id); else n.add(id); } return n; });
  }, [target]);

  return { target, saved, on, set, setOn, has, toggle, addMany, note };
}
