-- DV Cloud 0.12.0. Сейф: альбомы, которые администратор забрал у владельцев. Файлы остаются на диске без владельца, людям не видны,
-- защищены от стирания: внешний ключ vault_items.blob_id запрещает удалить файл-оригинал, пока он в сейфе (RESTRICT).
-- Достаются из сейфа только по паролю админки (его проверяет админка), в резервную копию попадают как все файлы.

CREATE TABLE vault_albums (
  id         bigserial PRIMARY KEY,
  name       text NOT NULL,
  note       text NOT NULL DEFAULT '',
  from_login text NOT NULL,                 -- у кого забрали (для возврата и для памяти)
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vault_items (
  vault_album_id bigint NOT NULL REFERENCES vault_albums(id) ON DELETE CASCADE,
  blob_id        bigint NOT NULL REFERENCES blobs(id) ON DELETE RESTRICT,
  name           text NOT NULL,              -- исходное имя файла
  taken_at       timestamptz NOT NULL,       -- исходная дата съёмки
  PRIMARY KEY (vault_album_id, blob_id)
);
CREATE INDEX vault_items_blob ON vault_items (blob_id);

-- Файл без владельца помнит исходное имя и дату съёмки: при «Отдать» они возвращаются, а не берутся из имени на диске.
ALTER TABLE blobs ADD COLUMN orphan_name text;
ALTER TABLE blobs ADD COLUMN orphan_taken_at timestamptz;
