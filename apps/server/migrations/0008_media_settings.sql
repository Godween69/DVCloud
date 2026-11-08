-- Настройки облака (ключ-значение), учёт копий видео «для просмотра» и пометка «скриншот проверен» у отпечатков.
-- Только добавляет таблицы: предыдущая версия приложения их не использует и на них не споткнётся.
CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Отпечатки, посчитанные до появления отметки «скриншот», перепроверяются в фоне по заголовку файла (быстро).
ALTER TABLE file_fingerprints ADD COLUMN shot_checked boolean NOT NULL DEFAULT false;

-- Одна копия на физический файл (blobs), даже если он у нескольких людей. Сам файл лежит в videos/<blob_id>.mp4.
-- status: ready (готова), skipped (копия не меньше оригинала, не нужна), failed (ffmpeg не справился).
-- params: с какими настройками сделана («720-28»); после смены настроек копия считается устаревшей.
CREATE TABLE video_copies (
  blob_id    bigint PRIMARY KEY REFERENCES blobs(id) ON DELETE CASCADE,
  status     text NOT NULL CHECK (status IN ('ready', 'skipped', 'failed')),
  params     text NOT NULL,
  size_bytes bigint NOT NULL DEFAULT 0,
  error      text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
