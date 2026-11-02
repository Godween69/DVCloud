-- Файлы людей (фото и видео). Оригиналы лежат на диске обычными файлами, база только индекс.
CREATE TABLE files (
  id            bigserial PRIMARY KEY,
  owner_id      bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  path          text NOT NULL,          -- путь внутри каталога данных, например library/anna/2026/05/IMG_1.jpg
  original_name text NOT NULL,          -- имя после очистки, как увидит человек
  mime          text NOT NULL,
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0),
  sha256        char(64) NOT NULL,
  taken_at      timestamptz NOT NULL,   -- дата снимка (пока со слов клиента, позже из EXIF)
  created_at    timestamptz NOT NULL DEFAULT now(),
  trashed_at    timestamptz             -- не NULL = лежит в корзине
);
-- Повтор у одного человека (тот же хэш среди не удалённых) отсекается самой базой, даже при гонке запросов.
CREATE UNIQUE INDEX files_owner_sha_live ON files (owner_id, sha256) WHERE trashed_at IS NULL;
-- Лента: свежие сверху.
CREATE INDEX files_owner_taken ON files (owner_id, taken_at DESC, id DESC) WHERE trashed_at IS NULL;
CREATE INDEX files_owner_trash ON files (owner_id, trashed_at DESC, id DESC) WHERE trashed_at IS NOT NULL;
