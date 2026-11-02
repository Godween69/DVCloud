import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Config } from '../config';
import { asObject, parseCookies, requireJson, strField } from '../http';
import { CONFIG } from '../tokens';
import { PublicUser, toPublic, UserRow } from '../users/users.service';
import { SessionGuard } from './session.guard';
import { SessionsService } from './sessions.service';

export const COOKIE = 'dvcloud_sid';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly sessions: SessionsService,
    @Inject(CONFIG) private readonly cfg: Config,
  ) {}

  private cookie(value: string, maxAgeSec: number): string {
    // HttpOnly: скрипты страницы не видят куку; SameSite=Lax: чужие сайты не могут её отправить.
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${this.cfg.cookieSecure ? '; Secure' : ''}`;
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ user: PublicUser }> {
    requireJson(req);
    const o = asObject(body);
    const login = strField(o, 'login', 1, 64);
    const password = strField(o, 'password', 1, 200);
    const { token, user } = await this.sessions.login(login, password, req.ip ?? 'unknown');
    res.setHeader('Set-Cookie', this.cookie(token, this.cfg.sessionIdleDays * 86400));
    res.setHeader('Cache-Control', 'no-store');
    return { user: toPublic(user) };
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@Req() req: Request & { user: UserRow }, @Res({ passthrough: true }) res: Response): { user: PublicUser } {
    res.setHeader('Cache-Control', 'no-store');
    return { user: toPublic(req.user) };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ ok: true }> {
    requireJson(req);
    await this.sessions.logout(parseCookies(req.headers.cookie)[COOKIE]);
    res.setHeader('Set-Cookie', this.cookie('', 0));
    return { ok: true };
  }
}
