-- Альбомы: у каждого человека свои. Файл лежит не больше чем в одном альбоме (смена альбома переносит его).
CREATE TABLE albums (
  id         bigserial PRIMARY KEY,
  owner_id   bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Имя альбома уникально у одного человека без учёта регистра.
CREATE UNIQUE INDEX albums_owner_name ON albums (owner_id, lower(name));

CREATE TABLE album_files (
  file_id  bigint PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  album_id bigint NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX album_files_album ON album_files (album_id);
