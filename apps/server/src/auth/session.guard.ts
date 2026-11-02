import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { parseCookies } from '../http';
import { UserRow } from '../users/users.service';
import { SessionsService } from './sessions.service';

// Пускает только с действующей сессией. Владелец определяется здесь, а не со слов клиента.
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionsService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: UserRow }>();
    const user = await this.sessions.authenticate(parseCookies(req.headers.cookie)['dvcloud_sid']);
    if (!user) throw new UnauthorizedException('Нужен вход');
    req.user = user;
    return true;
  }
}
