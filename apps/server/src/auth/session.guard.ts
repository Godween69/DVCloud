import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { parseCookies } from '../http';
import { UserRow } from '../users/users.service';
import { DeviceTokensService } from './device-tokens.service';
import { SessionsService } from './sessions.service';

// Детский аккаунт: только просмотр, всё остальное закрыто на сервере.
const CHILD_DENIED_READ = /^\/api\/(people|search|yandex|similar|auth\/security)(\/|$)|^\/api\/albums\/(suggestions|builder|people)(\/|$)|^\/api\/uploads(\/|$)|^\/api\/files\/trash(\/|$)/;
export function childAllowed(method: string, path: string): void {
  const read = method === 'GET' || method === 'HEAD';
  if (!read || CHILD_DENIED_READ.test(path)) throw new ForbiddenException('Эта возможность недоступна в детском аккаунте');
}

// Guard для аутентифицированных запросов.
// Пробует два механизма:
//   1) Кука dvcloud_sid (веб-сессия, как раньше)
//   2) Bearer dvc_... (токен устройства, с ECDSA-подписью)
// Первый успешный механизм выставляет req.user и req.authKind.
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionsService,
    private readonly deviceTokens: DeviceTokensService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: UserRow; authKind?: string }>();

    // 1) Пробуем веб-сессию (кука)
    const cookieUser = await this.sessions.authenticate(parseCookies(req.headers.cookie)['dvcloud_sid']);
    if (cookieUser) {
      req.user = cookieUser;
      req.authKind = 'session';
      if (cookieUser.is_child) childAllowed(req.method, req.path);
      return true;
    }

    // 2) Пробуем токен устройства
    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const body = req.body ? JSON.stringify(req.body) : '';
      const result = await this.deviceTokens.authenticate(
        token,
        req.method,
        req.originalUrl ?? req.url,
        req.headers['x-dv-timestamp'] as string | undefined,
        req.headers['x-dv-nonce'] as string | undefined,
        req.headers['x-dv-signature'] as string | undefined,
        body,
        req.ip ?? 'unknown',
      );
      if (result) {
        const { UsersService } = await import('../users/users.service');
        // UsersService инжектится отдельно (см. конструктор)
        const user = await (this as any).users?.findById(result.userId);
        if (user && !user.disabled) {
          req.user = user;
          req.authKind = 'device';
          if (user.is_child) childAllowed(req.method, req.path);
          return true;
        }
      }
    }

    throw new UnauthorizedException('Нужен вход');
  }
}
