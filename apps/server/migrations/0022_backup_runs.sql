-- DV Cloud 0.14.0: журнал резервных копий. Каждый запуск копирования записывается: когда, куда, что, сколько, чем закончился.
-- Из журнала админка проверяет копию, восстанавливает из неё и удаляет её. Файлов облака эта таблица не касается.
CREATE TABLE backup_runs (
  id            bigserial PRIMARY KEY,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  kind          text NOT NULL CHECK (kind IN ('folder', 'usb', 'ssh')),
  state         text NOT NULL CHECK (state IN ('running', 'done', 'error')),
  folder        text NOT NULL DEFAULT '',          -- имя папки копии относительно диска (для вывода)
  destination   text NOT NULL,                     -- полный путь папки копии (или user@host:путь)
  files         integer,
  bytes         bigint,
  db_bytes      bigint,
  error         text,
  dump_name     text,                              -- имя файла выгрузки базы в папке db этой копии
  migration     text,                              -- последняя применённая миграция базы на момент копии
  config        jsonb NOT NULL,                    -- настройки копии на момент запуска
  verified_at   timestamptz,
  verify_result jsonb,
  deleted_at    timestamptz                        -- копию удалили из админки; запись остаётся в истории
);
CREATE INDEX backup_runs_started_idx ON backup_runs (started_at DESC);
