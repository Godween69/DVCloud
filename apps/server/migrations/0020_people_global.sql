-- DV Cloud 0.13.0: люди общие для всего хранилища. Раньше у каждого человека были свои группы и свои имена,
-- поэтому в аккаунте Вали облако снова спрашивало, кто это. Теперь группа одна на всех: названа один раз, и профиль
-- человека строится по подписям всех. Список «Люди» у каждого по-прежнему показывает только тех, кто есть на его фото,
-- а доступ к самим файлам остаётся по-файловым.
--
-- Что делает миграция (всё в одной транзакции: при ошибке откатывается целиком):
-- 1. Копии прежних таблиц людей: people_backup_0020, detection_people_backup_0020, detection_rejects_backup_0020.
--    Они нигде не используются, их можно стереть вручную, когда убедитесь, что всё в порядке.
-- 2. «Скрыть» становится личным выбором: таблица people_hidden (кто скрыл у себя какую группу).
-- 3. Одноимённые группы разных людей (например «Валя» у Дмитрия и у Вали) сливаются в одну; ручные назначения и отказы «это не он» сохраняются.
-- 4. Безымянные автоматические группы стираются: лица из них заново соберутся в общие группы фоновым пересчётом.
--    Названные, скрытые и правленные вручную группы остаются как есть.
-- 5. Если одно и то же лицо было отнесено у двух людей к разным группам, остаётся одно назначение: ручное важнее
--    автоматического, названное важнее безымянного.
-- 6. Альбомные предложения: таблица отклонённых предложений.

CREATE TABLE people_backup_0020 AS TABLE people;
CREATE TABLE detection_people_backup_0020 AS TABLE detection_people;
CREATE TABLE detection_rejects_backup_0020 AS TABLE detection_rejects;

CREATE TABLE people_hidden (
  user_id   bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person_id bigint NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, person_id)
);
INSERT INTO people_hidden (user_id, person_id) SELECT owner_id, id FROM people WHERE hidden;

-- Одноимённые группы (с учётом регистра и вида): остаётся группа с меньшим номером.
CREATE TEMP TABLE _same_name ON COMMIT DROP AS
  SELECT p.id AS old_id, k.keep_id
  FROM people p
  JOIN (SELECT kind, lower(name) AS ln, min(id) AS keep_id FROM people WHERE name IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1) k
    ON k.kind = p.kind AND k.ln = lower(p.name)
  WHERE p.id <> k.keep_id;

INSERT INTO people_hidden (user_id, person_id)
  SELECT h.user_id, m.keep_id FROM people_hidden h JOIN _same_name m ON m.old_id = h.person_id ON CONFLICT DO NOTHING;
UPDATE detection_people dp SET person_id = m.keep_id FROM _same_name m WHERE dp.person_id = m.old_id;
INSERT INTO detection_rejects (detection_id, owner_id, person_id)
  SELECT dr.detection_id, dr.owner_id, m.keep_id FROM detection_rejects dr JOIN _same_name m ON m.old_id = dr.person_id ON CONFLICT DO NOTHING;
UPDATE people k SET cover_det = o.cover_det
  FROM (SELECT DISTINCT ON (m.keep_id) m.keep_id, p.cover_det FROM _same_name m JOIN people p ON p.id = m.old_id WHERE p.cover_det IS NOT NULL ORDER BY m.keep_id, p.id) o
  WHERE k.id = o.keep_id AND k.cover_det IS NULL;
DELETE FROM people WHERE id IN (SELECT old_id FROM _same_name);

-- Безымянные, не скрытые группы без ручных назначений собираются заново (общие для всех).
DELETE FROM people p
WHERE p.name IS NULL
  AND NOT EXISTS (SELECT 1 FROM people_hidden h WHERE h.person_id = p.id)
  AND NOT p.hidden
  AND NOT EXISTS (SELECT 1 FROM detection_people dp WHERE dp.person_id = p.id AND dp.source = 'manual');

-- Одно назначение на находку.
DELETE FROM detection_people dp
USING (
  SELECT x.detection_id, x.owner_id,
         row_number() OVER (PARTITION BY x.detection_id ORDER BY (x.source = 'manual') DESC, (p.name IS NOT NULL) DESC, x.owner_id, x.person_id) AS rn
  FROM detection_people x JOIN people p ON p.id = x.person_id
) r
WHERE dp.detection_id = r.detection_id AND dp.owner_id = r.owner_id AND r.rn > 1;
ALTER TABLE detection_people DROP COLUMN owner_id CASCADE;
ALTER TABLE detection_people ADD PRIMARY KEY (detection_id);

-- Отказы «это не он» тоже общие.
ALTER TABLE detection_rejects DROP COLUMN owner_id CASCADE;
DELETE FROM detection_rejects a USING detection_rejects b
  WHERE a.ctid < b.ctid AND a.detection_id = b.detection_id AND a.person_id = b.person_id;
ALTER TABLE detection_rejects ADD PRIMARY KEY (detection_id, person_id);

-- У группы больше нет хозяина; имя уникально среди людей и среди питомцев.
ALTER TABLE people DROP COLUMN owner_id CASCADE;
ALTER TABLE people DROP COLUMN hidden;
CREATE UNIQUE INDEX people_name_unique ON people (kind, lower(name)) WHERE name IS NOT NULL;

-- Предложенные альбомы (по времени съёмки): «Не нужно» запоминается по началу события.
CREATE TABLE album_suggestion_dismissed (
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, started_at)
);

-- «Это не человек» (например, кот, которого модель приняла за лицо): такая находка не спрашивается и не собирается в группы.
ALTER TABLE detections ADD COLUMN ignored boolean NOT NULL DEFAULT false;
