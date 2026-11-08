import type { SearchStatus } from '../types.ts';
import { plural } from './format.ts';

// Подсказка под строкой поиска: сколько файлов поиск уже «видит». Пустая строка: говорить нечего.
export function indexNote(s: SearchStatus | null): string {
  if (!s || !s.enabled) return '';
  if (!s.available) return 'Служба поиска сейчас не отвечает. Попробуйте позже.';
  if (s.total === 0) return '';
  if (s.indexed >= s.total) return '';
  const left = s.total - s.indexed;
  return `Поиск пока знает ${s.indexed} из ${s.total} файлов. Ещё ${left} ${plural(left, 'файл', 'файла', 'файлов')} обрабатывается в фоне, и они появятся в результатах позже.`;
}

// Примеры запросов под строкой, пока человек ничего не искал.
export const EXAMPLES = ['закат на море', 'собака', 'день рождения', 'снег зимой', 'скриншот переписки', 'еда на столе'];
