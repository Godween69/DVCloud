import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config';

async function bootstrap(): Promise<void> {
  const cfg = loadConfig();
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  await app.listen(cfg.port, cfg.host);
  console.log(`DVCloud server слушает ${cfg.host}:${cfg.port}`);
}

bootstrap().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
