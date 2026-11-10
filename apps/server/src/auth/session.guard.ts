import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { parseCookies } from '../http';
import { UserRow } from '../users/users.service';
import { SessionsService } from './sessions.service';

// Детский аккаунт: только смотреть. Всё, что меняет данные, и «взрослые» разделы закрыты на сервере, а не только скрыты в интерфейсе.
const CHILD_DENIED_READ = /^\/api\/(people|search|yandex|similar|auth\/security)(\/|$)|^\/api\/albums\/(suggestions|builder|people)(\/|$)|^\/api\/uploads(\/|$)|^\/api\/files\/trash(\/|$)/;
export function childAllowed(method: string, path: string): void {
  const read = method === 'GET' || method === 'HEAD';
  if (!read || CHILD_DENIED_READ.test(path)) throw new ForbiddenException('Эта возможность недоступна в детском аккаунте');
}

// Пускает только с действующей сессией. Владелец определяется здесь, а не со слов клиента.
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionsService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: UserRow }>();
    const user = await this.sessions.authenticate(parseCookies(req.headers.cookie)['dvcloud_sid']);
    if (!user) throw new UnauthorizedException('Нужен вход');
    req.user = user;
    if (user.is_child) childAllowed(req.method, req.path);
    return true;
  }
}
