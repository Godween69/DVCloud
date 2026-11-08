-- Векторы (эмбеддинги) для поиска по смыслу. Только добавляет таблицу: предыдущая версия приложения её не использует.
-- Один вектор на физический файл (blobs), даже если он лежит у нескольких людей.
-- status: ready (вектор посчитан), failed (картинку не удалось прочитать или построить миниатюру).
-- model: какой моделью посчитано; после смены модели векторы считаются заново (старые несовместимы).
-- vector: float32 little-endian, уже нормирован (сходство = скалярное произведение).
CREATE TABLE embeddings (
  blob_id    bigint PRIMARY KEY REFERENCES blobs(id) ON DELETE CASCADE,
  status     text NOT NULL CHECK (status IN ('ready', 'failed')),
  model      text NOT NULL,
  vector     bytea,
  error      text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'ready') = (vector IS NOT NULL))
);
CREATE INDEX embeddings_model_status ON embeddings (model, status);
