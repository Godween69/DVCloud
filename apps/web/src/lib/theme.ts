import { useCallback, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';

// Тема как на лендинге: класс на <html> и значение в localStorage. По умолчанию тёмная (фото на ней смотрятся лучше).
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.classList.contains('light') ? 'light' : 'dark'));
  useEffect(() => {
    const el = document.documentElement;
    el.classList.remove('dark', 'light');
    el.classList.add(theme);
    try {
      localStorage.setItem('theme', theme);
    } catch {
      /* приватный режим: тема просто не запомнится */
    }
  }, [theme]);
  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);
  return [theme, toggle];
}
