import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { Config } from '../config';
import { CONFIG } from '../tokens';

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

// Внутренний порт открыт только по токену из окружения. Сравнение за постоянное время.
@Injectable()
export class InternalTokenGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly cfg: Config) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!m || !timingSafeEqual(digest(m[1]), digest(this.cfg.internalToken))) {
      throw new UnauthorizedException('Нужен токен');
    }
    return true;
  }
}
