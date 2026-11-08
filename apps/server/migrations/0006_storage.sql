-- Хранение «одна копия на всё облако».
-- Запись в files остаётся «записью человека» (его имя, дата, скрытие), а сам файл на диске описывает blobs:
-- один физический файл на одно содержимое (SHA-256), сколько бы людей и альбомов на него ни ссылалось.
-- Миграция только добавляет: старые таблицы и колонки не меняются и не удаляются, поэтому предыдущая версия
-- приложения продолжит работать на этой базе (откат образа безопасен).

CREATE TABLE blobs (
  id         bigserial PRIMARY KEY,
  sha256     char(64) NOT NULL UNIQUE,
  path       text NOT NULL,                      -- путь внутри каталога данных, как и files.path
  mime       text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE files ADD COLUMN blob_id bigint REFERENCES blobs(id) ON DELETE RESTRICT;

-- По одной записи blobs на каждое содержимое. Основным берётся не скрытый файл, затем самый старый.
INSERT INTO blobs (sha256, path, mime, size_bytes, created_at)
SELECT DISTINCT ON (sha256) sha256, path, mime, size_bytes, created_at
FROM files
ORDER BY sha256, (trashed_at IS NULL) DESC, id;

UPDATE files f SET blob_id = b.id FROM blobs b WHERE b.sha256 = f.sha256;

CREATE INDEX files_blob ON files (blob_id);

-- Лишние физические копии, найденные при переносе (одно содержимое лежало на диске несколько раз).
-- Ничего не удаляется: команда администратора «убрать лишние копии» проверяет каждую и стирает по одной.
CREATE TABLE blob_extra_paths (
  path    text PRIMARY KEY,
  blob_id bigint NOT NULL REFERENCES blobs(id) ON DELETE CASCADE
);
INSERT INTO blob_extra_paths (path, blob_id)
SELECT DISTINCT f.path, f.blob_id FROM files f JOIN blobs b ON b.id = f.blob_id WHERE f.path <> b.path;

-- Альбомы «многие ко многим»: одно фото может лежать в нескольких альбомах.
-- Старая album_files остаётся как есть (для отката образа), новая версия работает только с album_items.
CREATE TABLE album_items (
  album_id bigint NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  file_id  bigint NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (album_id, file_id)
);
CREATE INDEX album_items_file ON album_items (file_id);
INSERT INTO album_items (album_id, file_id, added_at) SELECT album_id, file_id, added_at FROM album_files;

-- Общий доступ к альбому: человек видит фото альбома и может сохранить их себе в библиотеку (без копирования на диске).
CREATE TABLE album_shares (
  album_id   bigint NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (album_id, user_id)
);
CREATE INDEX album_shares_user ON album_shares (user_id);

-- Загрузки по частям с докачкой: сам файл лежит в uploads/<id>, здесь только описание.
CREATE TABLE uploads (
  id         text PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  modified   text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX uploads_user ON uploads (user_id, name, size_bytes);

-- Просьбы человека добавить место: админ видит их в админке.
CREATE TABLE quota_requests (
  id          bigserial PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  need_bytes  bigint NOT NULL CHECK (need_bytes > 0),
  note        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX quota_requests_open ON quota_requests (created_at DESC) WHERE resolved_at IS NULL;
