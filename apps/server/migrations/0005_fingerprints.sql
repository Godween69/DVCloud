-- Отпечатки фото для поиска похожих: дубликаты (то же фото в худшем качестве) и серии (кадры одного момента).
-- Считаются в фоне при загрузке и для старых файлов; в базе только маленькие отпечатки, не картинки.
CREATE TABLE file_fingerprints (
  file_id     bigint PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  dhash       bytea  NOT NULL CHECK (octet_length(dhash) = 8),   -- 64 бита: отпечаток «разности соседних яркостей»
  tiny        bytea  NOT NULL CHECK (octet_length(tiny) = 192),  -- уменьшенная копия 8x8 цветных пикселей
  width       integer NOT NULL,                                  -- размеры после поворота по EXIF
  height      integer NOT NULL,
  sharpness   real   NOT NULL,                                   -- резкость (дисперсия лапласиана): чем больше, тем чётче
  clip        bytea,                                             -- вектор CLIP (512 чисел float32), заполнится позже
  computed_at timestamptz NOT NULL DEFAULT now()
);
