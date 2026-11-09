// Конфигурация сервера из переменных окружения. Секреты не печатаются.
export interface Config {
  port: number;
  host: string;
  internalPort: number; // внутренний порт для админки, наружу не публикуется
  internalHost: string;
  internalToken: string;
  databaseUrl: string;
  dataDir: string;
  cookieSecure: boolean;
  trustProxy: number; // сколько прокси стоит перед сервером (0 = никого)
  sessionIdleDays: number;
  maxUploadBytes: number; // предел размера одного файла
  authUrl: string; // адрес сервиса DV Auth (второй фактор); пусто = второй фактор отключён
  authSecret: string; // секрет этого приложения в DV Auth
  mlUrl: string; // адрес ML-сервиса (поиск по смыслу); пусто = поиск недоступен
  secretsKey: string; // ключ шифрования чужих секретов в базе (сессия Яндекса); пусто = раздел «Яндекс Диск» выключен
  yandexLoginUrl: string; // адрес помощника входа по QR (отдельный контейнер); пусто = раздел выключен
  yandexLoginToken: string; // общий секрет сервера и помощника входа
  yandexBase: string; // адрес Диска (меняется только в тестах)
}

function intVar(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number): number {
  const raw = env[name];
  const v = raw === undefined || raw === '' ? def : Number(raw);
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new Error(`${name} должен быть целым числом от ${min} до ${max}`);
  }
  return v;
}

export function databaseUrlFrom(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DVCLOUD_DATABASE_URL ?? '';
  if (!url) throw new Error('Не задан DVCLOUD_DATABASE_URL');
  return url;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = intVar(env, 'DVCLOUD_PORT', 3004, 1, 65535);
  const internalPort = intVar(env, 'DVCLOUD_INTERNAL_PORT', 3006, 1, 65535);
  if (port === internalPort) throw new Error('DVCLOUD_PORT и DVCLOUD_INTERNAL_PORT должны различаться');
  const internalToken = env.DVCLOUD_INTERNAL_TOKEN ?? '';
  if (internalToken.length < 32) {
    throw new Error('DVCLOUD_INTERNAL_TOKEN должен быть не короче 32 символов');
  }
  const authUrl = (env.DVCLOUD_AUTH_URL ?? '').trim().replace(/\/+$/, '');
  const authSecret = env.DVCLOUD_AUTH_SECRET ?? '';
  if ((authUrl === '') !== (authSecret === '')) throw new Error('DVCLOUD_AUTH_URL и DVCLOUD_AUTH_SECRET задаются вместе');
  if (authUrl !== '' && !/^https?:\/\//.test(authUrl)) throw new Error('DVCLOUD_AUTH_URL должен начинаться с http:// или https://');
  if (authSecret !== '' && authSecret.length < 32) throw new Error('DVCLOUD_AUTH_SECRET должен быть не короче 32 символов');
  const mlUrl = (env.DVCLOUD_ML_URL ?? '').trim().replace(/\/+$/, '');
  if (mlUrl !== '' && !/^https?:\/\//.test(mlUrl)) throw new Error('DVCLOUD_ML_URL должен начинаться с http:// или https://');
  const secretsKey = env.DVCLOUD_SECRETS_KEY ?? '';
  if (secretsKey !== '' && secretsKey.length < 32) throw new Error('DVCLOUD_SECRETS_KEY должен быть не короче 32 символов');
  const yandexLoginUrl = (env.DVCLOUD_YANDEX_LOGIN_URL ?? '').trim().replace(/\/+$/, '');
  if (yandexLoginUrl !== '' && !/^https?:\/\//.test(yandexLoginUrl)) throw new Error('DVCLOUD_YANDEX_LOGIN_URL должен начинаться с http:// или https://');
  const yandexLoginToken = env.DVCLOUD_YANDEX_LOGIN_TOKEN ?? '';
  if (yandexLoginUrl !== '' && (secretsKey === '' || yandexLoginToken.length < 32)) {
    throw new Error('Для раздела «Яндекс Диск» нужны DVCLOUD_SECRETS_KEY и DVCLOUD_YANDEX_LOGIN_TOKEN (не короче 32 символов)');
  }
  const yandexBase = (env.DVCLOUD_YANDEX_BASE ?? 'https://disk.yandex.ru').replace(/\/+$/, '');
  return {
    port,
    host: env.DVCLOUD_HOST ?? '127.0.0.1',
    internalPort,
    internalHost: env.DVCLOUD_INTERNAL_HOST ?? '127.0.0.1',
    internalToken,
    databaseUrl: databaseUrlFrom(env),
    dataDir: env.DVCLOUD_DATA_DIR ?? './data',
    cookieSecure: (env.DVCLOUD_COOKIE_SECURE ?? 'true') !== 'false',
    trustProxy: intVar(env, 'DVCLOUD_TRUST_PROXY', 0, 0, 10),
    sessionIdleDays: intVar(env, 'DVCLOUD_SESSION_IDLE_DAYS', 14, 1, 365),
    maxUploadBytes: intVar(env, 'DVCLOUD_MAX_UPLOAD_BYTES', 50 * 1024 ** 3, 1, Number.MAX_SAFE_INTEGER),
    authUrl,
    authSecret,
    mlUrl,
    secretsKey,
    yandexLoginUrl,
    yandexLoginToken,
    yandexBase,
  };
}
