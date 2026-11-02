import { useCallback, useState } from 'react';

// Запоминаемая настройка интерфейса (режим сетки, размер плиток). Если localStorage недоступен, настройка живёт до перезагрузки.
export function usePref<T extends string>(key: string, def: T, allowed: readonly T[]): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const s = localStorage.getItem(`dvcloud.${key}`) as T | null;
      return s && allowed.includes(s) ? s : def;
    } catch {
      return def;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(`dvcloud.${key}`, v);
      } catch {
        /* не запомнится, ничего страшного */
      }
    },
    [key],
  );
  return [value, set];
}
