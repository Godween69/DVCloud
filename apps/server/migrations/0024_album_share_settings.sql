-- Shared albums в библиотеке (0.15.0): настройки видимости для альбомов, которыми поделились.
-- По умолчанию все переключатели включены (как у своих альбомов), поэтому существующие данные не меняются.
-- Человек может скрыть фото shared-альбома из своей библиотеки, фото, видео или скриншотов.
CREATE TABLE album_share_settings (
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  album_id bigint NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  in_library boolean NOT NULL DEFAULT true,
  in_photos boolean NOT NULL DEFAULT true,
  in_videos boolean NOT NULL DEFAULT true,
  in_screenshots boolean NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, album_id)
);
