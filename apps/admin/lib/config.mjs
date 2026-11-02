// Настройки админки из окружения. Секреты не печатаются.
function intVar(env, name, def, min, max) {
  const raw = env[name];
  const v = raw === undefined || raw === '' ? def : Number(raw);
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name} должен быть целым числом от ${min} до ${max}`);
  return v;
}

export function loadAdminConfig(env = process.env) {
  const token = env.DVCLOUD_INTERNAL_TOKEN ?? '';
  if (token.length < 32) throw new Error('DVCLOUD_INTERNAL_TOKEN должен быть не короче 32 символов');
  const hash = env.DVCLOUD_ADMIN_PASSWORD_HASH ?? '';
  if (!hash.startsWith('scrypt$')) {
    throw new Error('Не задан DVCLOUD_ADMIN_PASSWORD_HASH (задай пароль: npm run admin:set-password)');
  }
  const internalUrl = (env.DVCLOUD_INTERNAL_URL ?? 'http://127.0.0.1:3006').replace(/\/+$/, '');
  if (!/^http:\/\/[^/]+$/.test(internalUrl)) throw new Error('DVCLOUD_INTERNAL_URL должен быть вида http://адрес:порт');
  return {
    host: env.DVCLOUD_ADMIN_HOST ?? '127.0.0.1',
    port: intVar(env, 'DVCLOUD_ADMIN_PORT', 3005, 0, 65535),
    internalUrl,
    token,
    passwordHash: hash,
    extraHosts: (env.DVCLOUD_ADMIN_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    cookieSecure: env.DVCLOUD_ADMIN_COOKIE_SECURE === 'true',
  };
}
