-- DV Cloud 0.10.0: где показывать альбом, удаление альбома «в скрытые» и откуда взялись файлы без владельца.
-- Только добавляет столбцы и меняет уникальность имени альбома, существующие данные не меняются.

-- Допуски альбома: показывать ли его файлы в ленте раздела. Выключен допуск: файлы альбома в этом разделе не видны,
-- а внутри самого альбома видны всегда. По умолчанию везде включено, так что у всех всё остаётся как было.
ALTER TABLE albums
  ADD COLUMN in_library     boolean NOT NULL DEFAULT true,  -- раздел «Библиотека» (всё вместе) и поиск
  ADD COLUMN in_photos      boolean NOT NULL DEFAULT true,  -- раздел «Фото»
  ADD COLUMN in_videos      boolean NOT NULL DEFAULT true,  -- раздел «Видео»
  ADD COLUMN in_screenshots boolean NOT NULL DEFAULT true,  -- раздел «Скриншоты»
  ADD COLUMN deleted_at     timestamptz;                    -- человек удалил альбом: у него он пропал, админ видит его в «Удалённых»

-- Имя уникально среди живых альбомов: удалённый не мешает завести новый с тем же названием.
DROP INDEX IF EXISTS albums_owner_name;
CREATE UNIQUE INDEX albums_owner_name ON albums (owner_id, lower(name)) WHERE deleted_at IS NULL;

-- Откуда взялся файл без владельца: кто и когда убрал его насовсем, из какого альбома. Админ по этому видит,
-- мусор перед ним или то, что человек просто убрал вместе с альбомом.
ALTER TABLE blobs
  ADD COLUMN orphaned_at timestamptz,
  ADD COLUMN orphan_note text;
