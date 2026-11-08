-- Скриншоты отделяются от фото: метка ставится при расчёте отпечатка (по формату, наличию данных камеры и размерам экрана).
-- Только добавляет колонку: предыдущая версия приложения на ней не споткнётся.
ALTER TABLE file_fingerprints ADD COLUMN screenshot boolean NOT NULL DEFAULT false;
CREATE INDEX file_fingerprints_screenshot ON file_fingerprints (file_id) WHERE screenshot;
