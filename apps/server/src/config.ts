// Конфигурация сервера из переменных окружения. Секреты не печатаются.
export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  dataDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.DVCLOUD_PORT ?? 3004);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('DVCLOUD_PORT должен быть числом от 1 до 65535');
  }
  const databaseUrl = env.DVCLOUD_DATABASE_URL ?? '';
  if (!databaseUrl) {
    throw new Error('Не задан DVCLOUD_DATABASE_URL');
  }
  return {
    port,
    host: env.DVCLOUD_HOST ?? '127.0.0.1',
    databaseUrl,
    dataDir: env.DVCLOUD_DATA_DIR ?? './data',
  };
}
