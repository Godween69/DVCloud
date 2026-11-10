-- DV Cloud 0.11.3. Только добавляет столбцы, существующие данные не меняются (откат образа безопасен).

-- 1. Миниатюры привязаны к файлу-оригиналу в базе: thumb_at это «миниатюра построена», thumb_failed_at это «разобрать не вышло».
--    Фоновая служба строит миниатюры только тем оригиналам, у которых ещё пусто, и не пересматривает диск каждый раз.
--    Миниатюра лежит на диске как thumbs-fit/<id оригинала>.webp и уходит вместе с оригиналом.
ALTER TABLE blobs ADD COLUMN thumb_at timestamptz;
ALTER TABLE blobs ADD COLUMN thumb_failed_at timestamptz;
CREATE INDEX blobs_thumb_todo ON blobs (id DESC) WHERE thumb_at IS NULL;

-- 2. Альбомы по типу. 'any' универсальный (все прежние альбомы), 'photos', 'videos', 'screenshots'. Тип выбирается при создании и не меняется.
--    favorite это звёздочка владельца: избранные альбомы идут первыми.
ALTER TABLE albums ADD COLUMN kind text NOT NULL DEFAULT 'any' CHECK (kind IN ('any', 'photos', 'videos', 'screenshots'));
ALTER TABLE albums ADD COLUMN favorite boolean NOT NULL DEFAULT false;

-- 3. Дубликаты: файлы, которые администратор осознанно оставил оба («не удалять»). Поиск дубликатов их больше не предлагает.
CREATE TABLE dup_keep (
  blob_id    bigint PRIMARY KEY REFERENCES blobs(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
