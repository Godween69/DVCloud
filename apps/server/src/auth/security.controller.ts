import { Body, Controller, Delete, Get, HttpCode, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { asObject, optStrField, requireJson, strField } from '../http';
import { UserRow } from '../users/users.service';
import { ChatChallenge, DvAuthClient, FactorStatus } from './dvauth.client';
import { SessionGuard } from './session.guard';
import { SessionsService } from './sessions.service';

type Authed = Request & { user: UserRow };

// Настройки второго фактора. Сами факторы хранит DV Auth; здесь только проверка прав.
// Все действия под сессией; опасные ещё и с паролем (а если включены коды из приложения, то и с кодом).
@Controller('auth/security')
@UseGuards(SessionGuard)
export class SecurityController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly dvauth: DvAuthClient,
  ) {}

  private ip(req: Request): string {
    return req.ip ?? 'unknown';
  }

  private async confirmPassword(req: Authed, o: Record<string, unknown>): Promise<void> {
    const user = await this.sessions.checkCredentials(req.user.login, strField(o, 'password', 1, 200), this.ip(req));
    if (user.id !== req.user.id) throw new UnauthorizedException('Неверный пароль');
  }

  private async confirmFactor(req: Authed, o: Record<string, unknown>): Promise<void> {
    await this.confirmPassword(req, o);
    const st = await this.dvauth.status(req.user.id);
    if (!st.totpEnabled) return;
    const code = optStrField(o, 'code', 1, 40);
    if (!code) throw new UnauthorizedException('Нужен действующий код из приложения или запасной код');
    await this.dvauth.call('POST', '/v1/check', { subject: req.user.id, code, ip: this.ip(req) });
  }

  private subject(req: Authed): { subject: string } {
    return { subject: req.user.id };
  }

  @Get()
  async get(@Req() req: Authed, @Res({ passthrough: true }) res: Response): Promise<Partial<FactorStatus> & { available: boolean }> {
    res.setHeader('Cache-Control', 'no-store');
    if (!this.dvauth.enabled) return { available: false };
    return { available: true, ...(await this.dvauth.status(req.user.id)) };
  }

  @Post('totp/begin')
  @HttpCode(200)
  async totpBegin(@Body() body: unknown, @Req() req: Authed, @Res({ passthrough: true }) res: Response): Promise<{ secret: string; uri: string }> {
    requireJson(req);
    await this.confirmPassword(req, asObject(body));
    res.setHeader('Cache-Control', 'no-store');
    return this.dvauth.call('POST', '/v1/totp/begin', { ...this.subject(req), label: req.user.login });
  }

  @Post('totp/enable')
  @HttpCode(200)
  async totpEnable(@Body() body: unknown, @Req() req: Authed, @Res({ passthrough: true }) res: Response): Promise<{ recoveryCodes: string[] | null }> {
    requireJson(req);
    res.setHeader('Cache-Control', 'no-store');
    return this.dvauth.call('POST', '/v1/totp/enable', { ...this.subject(req), code: strField(asObject(body), 'code', 6, 6) });
  }

  @Post('totp/disable')
  @HttpCode(200)
  async totpDisable(@Body() body: unknown, @Req() req: Authed): Promise<{ ok: true }> {
    requireJson(req);
    await this.confirmFactor(req, asObject(body));
    return this.dvauth.call('POST', '/v1/totp/disable', this.subject(req));
  }

  @Post('recovery/new')
  @HttpCode(200)
  async recoveryNew(@Body() body: unknown, @Req() req: Authed, @Res({ passthrough: true }) res: Response): Promise<{ recoveryCodes: string[] }> {
    requireJson(req);
    await this.confirmFactor(req, asObject(body));
    res.setHeader('Cache-Control', 'no-store');
    return this.dvauth.call('POST', '/v1/recovery/new', this.subject(req));
  }

  @Post('chat/start')
  @HttpCode(200)
  async chatStart(@Body() body: unknown, @Req() req: Authed, @Res({ passthrough: true }) res: Response): Promise<ChatChallenge> {
    requireJson(req);
    await this.confirmFactor(req, asObject(body));
    res.setHeader('Cache-Control', 'no-store');
    return this.dvauth.call('POST', '/v1/chat/link/start', { ...this.subject(req), ip: this.ip(req), agent: String(req.headers['user-agent'] ?? '').slice(0, 200) });
  }

  @Post('chat/status')
  @HttpCode(200)
  async chatStatus(@Req() req: Authed, @Res({ passthrough: true }) res: Response): Promise<unknown> {
    requireJson(req);
    res.setHeader('Cache-Control', 'no-store');
    return this.dvauth.call('POST', '/v1/chat/link/status', this.subject(req));
  }

  @Delete('chat')
  async chatUnlink(@Body() body: unknown, @Req() req: Authed): Promise<{ ok: true }> {
    requireJson(req);
    await this.confirmFactor(req, asObject(body));
    return this.dvauth.call('POST', '/v1/chat/unlink', this.subject(req));
  }
}
