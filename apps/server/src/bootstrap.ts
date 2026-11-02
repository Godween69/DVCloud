import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule, InternalModule } from './app.module';
import { Config } from './config';

// Собирает два приложения: публичное (/api) и внутреннее (/internal). Слушать порты должен вызывающий.
export async function createApps(cfg: Config, quiet = false): Promise<{ pub: NestExpressApplication; internal: NestExpressApplication }> {
  const logger = quiet ? false : undefined;
  const pub = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(cfg), { logger });
  pub.setGlobalPrefix('api');
  pub.set('trust proxy', cfg.trustProxy > 0 ? cfg.trustProxy : false);
  pub.disable('x-powered-by');
  const internal = await NestFactory.create<NestExpressApplication>(InternalModule.forRoot(cfg), { logger });
  internal.disable('x-powered-by');
  return { pub, internal };
}
