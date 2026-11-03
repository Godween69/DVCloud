import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Config } from '../config';
import { asObject, parseCookies, requireJson, strField } from '../http';
import { CONFIG } from '../tokens';
import { PublicUser, toPublic, UserRow, UsersService } from '../users/users.service';
import { SessionGuard } from './session.guard';
import { SessionsService } from './sessions.service';
import { ChatChallenge, DvAuthClient } from './dvauth.client';

export const COOKIE = 'dvcloud_sid';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly dvauth: DvAuthClient,
    private readonly users: UsersService,
    @Inject(CONFIG) private readonly cfg: Config,
  ) {}

  private cookie(value: string, maxAgeSec: number): string {
    // HttpOnly: скрипты страницы не видят куку; SameSite=Lax: чужие сайты не могут её отправить.
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${this.cfg.cookieSecure ? '; Secure' : ''}`;
  }

  private async finish(res: Response, user: UserRow): Promise<{ user: PublicUser }> {
    const token = await this.sessions.createSession(user.id);
    res.setHeader('Set-Cookie', this.cookie(token, this.cfg.sessionIdleDays * 86400));
    res.setHeader('Cache-Control', 'no-store');
    return { user: toPublic(user) };
  }

  // Для этого человека сессия открывается только если он ещё активен (второй шаг мог идти минуты).
  private async finishById(res: Response, subject: string): Promise<{ user: PublicUser }> {
    const user = await this.users.findById(subject);
    if (!user || user.disabled) throw new UnauthorizedException('Вход недоступен');
    return this.finish(res, user);
  }

  // Шаг 1: пароль. Если у человека включён второй фактор (его знает DV Auth), сессии ещё нет:
  // возвращается талон на 5 минут и список способов. Сервис недоступен: вход закрыт (503), а не открыт.
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ user: PublicUser } | { twoFactor: { ticket: string; methods: string[] } }> {
    requireJson(req);
    const o = asObject(body);
    const ip = req.ip ?? 'unknown';
    const user = await this.sessions.checkCredentials(strField(o, 'login', 1, 64), strField(o, 'password', 1, 200), ip);
    res.setHeader('Cache-Control', 'no-store');
    if (this.dvauth.enabled) {
      const r = await this.dvauth.call<{ required: boolean; ticket?: string; methods?: string[] }>('POST', '/v1/login/begin', { subject: user.id, ip });
      if (r.required && r.ticket) return { twoFactor: { ticket: r.ticket, methods: r.methods ?? [] } };
    }
    await this.sessions.clearFails(user.login);
    return this.finish(res, user);
  }

  // Шаг 2а: код из приложения-аутентификатора или запасной код.
  @Post('2fa/code')
  @HttpCode(200)
  async code(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ user: PublicUser }> {
    requireJson(req);
    const o = asObject(body);
    const r = await this.dvauth.call<{ subject: string }>('POST', '/v1/login/code', {
      ticket: strField(o, 'ticket', 20, 64),
      code: strField(o, 'code', 1, 40),
      ip: req.ip ?? 'unknown',
    });
    return this.finishById(res, r.subject);
  }

  // Шаг 2б: подтверждение в DVChat. start выдаёт QR и число, status опрашивает страница входа.
  @Post('2fa/chat/start')
  @HttpCode(200)
  async chatStart(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<ChatChallenge> {
    requireJson(req);
    res.setHeader('Cache-Control', 'no-store');
    return this.dvauth.call('POST', '/v1/login/chat/start', {
      ticket: strField(asObject(body), 'ticket', 20, 64),
      ip: req.ip ?? 'unknown',
      agent: String(req.headers['user-agent'] ?? '').slice(0, 200),
    });
  }

  @Post('2fa/chat/status')
  @HttpCode(200)
  async chatStatus(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ state: string; user?: PublicUser }> {
    requireJson(req);
    const r = await this.dvauth.call<{ state: string; subject?: string }>('POST', '/v1/login/chat/status', { ticket: strField(asObject(body), 'ticket', 20, 64) });
    if (r.state === 'approved' && r.subject) return { state: 'approved', ...(await this.finishById(res, r.subject)) };
    res.setHeader('Cache-Control', 'no-store');
    return { state: r.state };
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
