import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { validTimezone } from './taken';

// Настройки превью и видео-копий. Хранятся в таблице settings, меняются в админке.
export interface MediaSettings {
  previewEnabled: boolean; // превью для просмотра фото (иначе сайт открывает оригинал)
  previewMaxSide: number; // длинная сторона, px
  previewQuality: number; // качество WebP, 30-95
  videoEnabled: boolean; // делать и отдавать копии видео для просмотра
  videoHeight: number; // высота копии, px
  videoCrf: number; // качество x264: меньше число, лучше картинка и больше файл (18-35)
  timezone: string; // пояс, в котором записано время без пояса (EXIF, имя файла): так определяется дата съёмки
}

export const DEFAULT_MEDIA: MediaSettings = {
  previewEnabled: true,
  previewMaxSide: 2000,
  previewQuality: 80,
  videoEnabled: false, // перекодирование нагружает процессор: включается осознанно
  videoHeight: 720,
  videoCrf: 28,
  timezone: 'UTC',
};

export const VIDEO_HEIGHTS = [480, 720, 1080];
const RANGES: Record<'previewMaxSide' | 'previewQuality' | 'videoCrf', [number, number]> = {
  previewMaxSide: [600, 4000],
  previewQuality: [30, 95],
  videoCrf: [18, 35],
};

// Проверяет частичное изменение настроек; неизвестные поля и значения вне границ дают 400 с понятным текстом.
export function parseMediaPatch(input: unknown): Partial<MediaSettings> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new BadRequestException('Ожидался объект с настройками');
  const o = input as Record<string, unknown>;
  const out: Partial<MediaSettings> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === 'previewEnabled' || k === 'videoEnabled') {
      if (typeof v !== 'boolean') throw new BadRequestException(`${k}: ожидалось да или нет`);
      out[k] = v;
    } else if (k === 'previewMaxSide' || k === 'previewQuality' || k === 'videoCrf') {
      const [lo, hi] = RANGES[k];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw new BadRequestException(`${k}: целое число от ${lo} до ${hi}`);
      out[k] = v;
    } else if (k === 'timezone') {
      if (typeof v !== 'string' || !validTimezone(v)) throw new BadRequestException('timezone: название пояса, например Europe/Moscow');
      out[k] = v;
    } else if (k === 'videoHeight') {
      if (typeof v !== 'number' || !VIDEO_HEIGHTS.includes(v)) throw new BadRequestException(`videoHeight: одно из ${VIDEO_HEIGHTS.join(', ')}`);
      out[k] = v;
    } else {
      throw new BadRequestException(`Неизвестная настройка: ${k}`);
    }
  }
  return out;
}

// Строка, по которой видно, делалась ли копия видео с текущими настройками.
export const videoParams = (s: Pick<MediaSettings, 'videoHeight' | 'videoCrf'>): string => `${s.videoHeight}-${s.videoCrf}`;

@Injectable()
export class MediaSettingsService {
  private cache: { at: number; value: MediaSettings } | null = null;
  static readonly TTL_MS = 2000;

  constructor(@Inject(DbService) private readonly db: DbService) {}

  // С кэшем на пару секунд (внутренний порт меняет настройки в своём экземпляре службы): публичный порт читает настройки на каждый запрос превью.
  async get(fresh = false): Promise<MediaSettings> {
    if (!fresh && this.cache && Date.now() - this.cache.at < MediaSettingsService.TTL_MS) return this.cache.value;
    const rows = (await this.db.query<{ key: string; value: unknown }>("SELECT key, value FROM settings WHERE key = 'media'")).rows;
    const stored = rows[0] && typeof rows[0].value === 'object' && rows[0].value !== null ? (rows[0].value as Record<string, unknown>) : {};
    let value: MediaSettings = { ...DEFAULT_MEDIA };
    try {
      value = { ...DEFAULT_MEDIA, ...parseMediaPatch(stored) };
    } catch {
      /* испорченная запись: работаем на значениях по умолчанию */
    }
    this.cache = { at: Date.now(), value };
    return value;
  }

  async save(patch: Partial<MediaSettings>): Promise<{ before: MediaSettings; after: MediaSettings }> {
    const before = await this.get(true);
    const after = { ...before, ...patch };
    await this.db.query(
      `INSERT INTO settings (key, value) VALUES ('media', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(after)],
    );
    this.cache = { at: Date.now(), value: after };
    return { before, after };
  }
}
