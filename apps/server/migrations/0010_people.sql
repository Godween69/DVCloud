-- Лица и питомцы на фото. Только добавляет таблицы: предыдущая версия приложения их не использует.
--
-- detections: то, что нашла нейросеть на файле-оригинале (blobs): лицо, кошка или собака. Одна запись на находку,
--   даже если файл лежит у нескольких людей. Рамка хранится в долях картинки (0..1) уже после поворота по EXIF.
--   vector: float32 little-endian, нормирован (лицо 128 чисел, питомец как у поиска по смыслу).
--   model: какой моделью найдено; после смены модели файл просматривается заново.
-- detection_scans: какие файлы уже просмотрены (faces или pets), чем и с каким итогом.
-- people: люди и питомцы ЧЕЛОВЕКА (группы находок). name пустой, пока группа без имени. hidden: не показывать в списке.
--   Имена и группы у каждого свои: чужие не видят, как вы назвали человека.
-- detection_people: к какой группе человека отнесена находка (source: auto сделала программа, manual указал человек).
-- detection_rejects: «это не он»: находка не возвращается в эту группу при пересчёте.
CREATE TABLE detections (
  id       bigserial PRIMARY KEY,
  blob_id  bigint NOT NULL REFERENCES blobs(id) ON DELETE CASCADE,
  kind     text NOT NULL CHECK (kind IN ('face', 'cat', 'dog')),
  x        real NOT NULL,
  y        real NOT NULL,
  w        real NOT NULL,
  h        real NOT NULL,
  score    real NOT NULL,
  model    text NOT NULL,
  vector   bytea NOT NULL
);
CREATE INDEX detections_blob ON detections (blob_id);

CREATE TABLE detection_scans (
  blob_id    bigint NOT NULL REFERENCES blobs(id) ON DELETE CASCADE,
  what       text NOT NULL CHECK (what IN ('faces', 'pets')),
  model      text NOT NULL,
  status     text NOT NULL CHECK (status IN ('done', 'failed')),
  error      text,
  scanned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blob_id, what)
);

CREATE TABLE people (
  id         bigserial PRIMARY KEY,
  owner_id   bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('person', 'pet')),
  name       text CHECK (name IS NULL OR (char_length(name) BETWEEN 1 AND 60)),
  hidden     boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX people_owner ON people (owner_id);

CREATE TABLE detection_people (
  detection_id bigint NOT NULL REFERENCES detections(id) ON DELETE CASCADE,
  owner_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person_id    bigint NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  source       text NOT NULL CHECK (source IN ('auto', 'manual')),
  PRIMARY KEY (detection_id, owner_id)
);
CREATE INDEX detection_people_person ON detection_people (person_id);

CREATE TABLE detection_rejects (
  detection_id bigint NOT NULL REFERENCES detections(id) ON DELETE CASCADE,
  owner_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person_id    bigint NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  PRIMARY KEY (detection_id, owner_id, person_id)
);
