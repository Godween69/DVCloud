-- Сессии входа. В базе только хеш токена: утечка базы не даёт войти.
CREATE TABLE sessions (
  id           bigserial PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- Неудачные попытки входа: по ним ограничивается подбор пароля.
CREATE TABLE login_attempts (
  id    bigserial PRIMARY KEY,
  login text NOT NULL,
  ip    text NOT NULL,
  at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_login_idx ON login_attempts (login, at);
CREATE INDEX login_attempts_ip_idx ON login_attempts (ip, at);

-- Журнал действий администратора.
CREATE TABLE audit_log (
  id      bigserial PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT now(),
  actor   text NOT NULL,
  action  text NOT NULL,
  target  text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
