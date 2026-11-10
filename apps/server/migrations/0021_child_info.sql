-- DV Cloud 0.13.0: роль «Ребёнок», ручная правка даты снимка, «Не знаю» в проверке догадок.

-- Детский аккаунт: упрощённый интерфейс, нельзя загружать, удалять, создавать альбомы; доступ ограничивает сервер.
ALTER TABLE users ADD COLUMN is_child boolean NOT NULL DEFAULT false;

-- Дату снимка вручную исправил администратор: пересчёт дат в админке такой файл не трогает.
ALTER TABLE files ADD COLUMN taken_manual boolean NOT NULL DEFAULT false;

-- «Не знаю, кто это» в очереди догадок: эта находка больше не спрашивается у этого человека.
CREATE TABLE face_skips (
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  detection_id bigint NOT NULL REFERENCES detections(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, detection_id)
);
