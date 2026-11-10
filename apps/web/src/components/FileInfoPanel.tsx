import { Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type FileInfo } from '../api';
import { formatBytes, formatDateTime } from '../lib/format';

// Откуда взята дата съёмки: понятными словами.
export function dateSource(used: FileInfo['dates']['used']): string {
  return used === 'meta' ? 'из данных самого файла (метаданные камеры)' : used === 'name' ? 'из названия файла' : used === 'manual' ? 'исправлена вручную администратором' : 'в файле даты нет, взята дата изменения файла';
}

const EXIF_LABEL: Record<string, string> = {
  DateTimeOriginal: 'Снято (DateTimeOriginal)', DateTimeDigitized: 'Оцифровано (DateTimeDigitized)', DateTime: 'Изменено (DateTime)',
  Make: 'Производитель', Model: 'Модель', Software: 'Программа',
};

// Окно «Инфо» в просмотрщике: всё, что известно о файле, и откуда взята дата. Помогает понять, почему фото лежит не там, где ждали.
export function FileInfoPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    setInfo(null); setErr('');
    api.fileInfo(id).then((r) => { if (live) setInfo(r); }).catch(() => { if (live) setErr('Не получилось загрузить сведения о файле'); });
    return () => { live = false; };
  }, [id]);
  const row = (k: string, v: string | null | undefined) => v ? <div key={k} className="grid grid-cols-[8.5rem_1fr] gap-2 py-1 text-sm"><dt className="text-white/55">{k}</dt><dd className="min-w-0 break-words text-white">{v}</dd></div> : null;
  return (
    <aside role="dialog" aria-label="Сведения о файле" onClick={(e) => e.stopPropagation()} className="glass-strong absolute bottom-3 right-3 top-16 z-20 flex w-[min(24rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-2xl text-white">
      <div className="flex items-center justify-between px-4 py-3">
        <h3 className="font-semibold">Инфо</h3>
        <button type="button" onClick={onClose} aria-label="Закрыть сведения" className="flex size-8 items-center justify-center rounded-full hover:bg-white/15"><X className="size-4" aria-hidden /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {err && <p className="text-sm text-red-300">{err}</p>}
        {!info && !err && <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin" aria-label="Загружаем" /></div>}
        {info && (
          <>
            <dl>
              {row('Имя', info.name)}
              {row('Тип', info.mime)}
              {row('Размер', formatBytes(info.size))}
              {row('Кадр', info.width && info.height ? `${info.width} × ${info.height}` : null)}
              {row('Добавлен', formatDateTime(info.createdAt))}
              {row('Альбомы', info.albums.length ? info.albums.map((a) => a.name).join(', ') : 'ни в одном')}
              {row('Контрольная сумма', info.sha256)}
            </dl>
            <h4 className="mb-1 mt-4 text-sm font-semibold">Дата съёмки</h4>
            <p className="text-base">{formatDateTime(info.takenAt)}</p>
            <p className="mt-0.5 text-sm text-white/70">Источник: {dateSource(info.dates.used)}</p>
            <dl className="mt-2 border-t border-white/10 pt-2">
              {row('В метаданных', info.dates.exifDate ? formatDateTime(info.dates.exifDate) : 'нет')}
              {row('В видео', info.dates.videoCreation ? formatDateTime(info.dates.videoCreation) : null)}
              {row('В имени файла', info.dates.nameDate ? formatDateTime(info.dates.nameDate) : 'нет')}
            </dl>
            {Object.keys(info.dates.exif).length > 0 && (
              <>
                <h4 className="mb-1 mt-4 text-sm font-semibold">Метаданные</h4>
                <dl>{Object.entries(info.dates.exif).map(([k, v]) => row(EXIF_LABEL[k] ?? k, v))}</dl>
              </>
            )}
            {info.dates.used !== 'meta' && info.dates.used !== 'manual' && info.dates.exifDate === null && <p className="mt-3 text-xs text-white/60">Если дата неверная, попросите администратора исправить её в разделе «Хранилище».</p>}
          </>
        )}
      </div>
    </aside>
  );
}
