import { createApps } from './bootstrap';
import { loadConfig } from './config';

async function bootstrap(): Promise<void> {
  const cfg = loadConfig();
  const { pub, internal } = await createApps(cfg);
  await pub.listen(cfg.port, cfg.host);
  await internal.listen(cfg.internalPort, cfg.internalHost);
  console.log(`DVCloud server: публичный ${cfg.host}:${cfg.port}, внутренний ${cfg.internalHost}:${cfg.internalPort}`);
}

bootstrap().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
