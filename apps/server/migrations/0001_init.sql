-- Пользователи облака. Аккаунты создаёт администратор, самостоятельной регистрации нет.
CREATE TABLE users (
  id            bigserial PRIMARY KEY,
  login         text NOT NULL UNIQUE CHECK (login ~ '^[a-z0-9_]{2,32}$'),
  display_name  text NOT NULL,
  password_hash text NOT NULL,
  is_admin      boolean NOT NULL DEFAULT false,
  disabled      boolean NOT NULL DEFAULT false,
  quota_bytes   bigint,
  created_at    timestamptz NOT NULL DEFAULT now()
);
