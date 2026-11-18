-- Токены устройств: долгоживущие привязки для автовыгрузки фото.
-- В базе только хеш токена и публичный ключ устройства.
-- 1 активное устройство на пользователя.
CREATE TABLE device_tokens (
  id            bigserial PRIMARY KEY,
  user_id       bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL UNIQUE,
  device_name   text NOT NULL,
  device_pubkey bytea NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_ip       text,
  revoked_at    timestamptz
);
CREATE INDEX device_tokens_user_idx ON device_tokens (user_id);
CREATE INDEX device_tokens_active_idx ON device_tokens (user_id) WHERE revoked_at IS NULL;
