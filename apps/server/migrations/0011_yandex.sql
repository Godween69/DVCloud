-- Яндекс Диск: подключённый аккаунт человека и список его файлов в безлимите (импорт в одну сторону: из Яндекса к нам).
-- Сессия Яндекса лежит в базе только зашифрованной (AES-256-GCM, ключ из DVCLOUD_SECRETS_KEY).
CREATE TABLE yandex_accounts (
  id            bigserial PRIMARY KEY,
  owner_id      bigint NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE, -- один Яндекс-аккаунт на человека
  session       bytea NOT NULL,                       -- зашифрованные куки
  state         text NOT NULL DEFAULT 'connected' CHECK (state IN ('connected', 'expired')),
  connected_at  timestamptz NOT NULL DEFAULT now(),
  listed_at     timestamptz,                          -- когда последний раз читали список
  list_state    text NOT NULL DEFAULT 'idle' CHECK (list_state IN ('idle', 'running', 'error')),
  list_note     text,                                 -- ход или причина ошибки чтения списка
  import_state  text NOT NULL DEFAULT 'idle' CHECK (import_state IN ('idle', 'running', 'paused')),
  import_note   text,                                 -- почему остановлено (квота, сессия, Яндекс)
  into_album    boolean NOT NULL DEFAULT true         -- класть забранное в альбом «Яндекс Диск»
);

CREATE TABLE yandex_items (
  id          bigserial PRIMARY KEY,
  account_id  bigint NOT NULL REFERENCES yandex_accounts(id) ON DELETE CASCADE,
  path        text NOT NULL,                          -- путь в безлимите, например /photounlim/IMG_1.jpg
  name        text NOT NULL,
  size_bytes  bigint NOT NULL DEFAULT 0,
  md5         char(32),
  taken_hint  timestamptz,                            -- время изменения по данным Яндекса (запасная дата снимка)
  state       text NOT NULL DEFAULT 'new' CHECK (state IN ('new', 'queued', 'done', 'waiting', 'failed', 'skipped')),
  attempts    integer NOT NULL DEFAULT 0,
  error       text,
  file_id     bigint REFERENCES files(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, path)
);
CREATE INDEX yandex_items_state ON yandex_items (account_id, state);
CREATE INDEX yandex_items_queue ON yandex_items (account_id, state, id) WHERE state IN ('queued', 'waiting');
