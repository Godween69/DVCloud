-- Яндекс Диск: повторная сверка. Ночная проверка новых файлов и итог последней сверки (сколько нового нашлось).
-- Только добавляет столбцы, существующие данные не меняет.
ALTER TABLE yandex_accounts
  ADD COLUMN auto_sync        boolean NOT NULL DEFAULT false, -- раз в сутки ночью заново читать список и искать новое
  ADD COLUMN sync_days        integer NOT NULL DEFAULT 1 CHECK (sync_days IN (1, 7, 30)), -- как часто: каждую ночь (1), раз в неделю (7), раз в месяц (30)
  ADD COLUMN auto_import      boolean NOT NULL DEFAULT false, -- найденное новое забирать сразу, без нажатия кнопки
  ADD COLUMN sync_at          timestamptz,                    -- когда закончилась последняя сверка (не первое чтение списка)
  ADD COLUMN sync_found       integer,                        -- сколько новых файлов нашла последняя сверка
  ADD COLUMN sync_found_bytes bigint;                         -- и сколько они весят

-- Когда файл впервые появился в нашем списке: по нему отличаем «нашлось при сверке» от старого.
ALTER TABLE yandex_items ADD COLUMN found_at timestamptz NOT NULL DEFAULT now();
