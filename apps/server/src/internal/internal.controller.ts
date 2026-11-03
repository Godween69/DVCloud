import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { DvAuthClient } from '../auth/dvauth.client';
import { AuditService } from '../db/audit.service';
import { asObject, optStrField, requireJson, strField } from '../http';
import { PublicUser, toPublic, UsersService } from '../users/users.service';
import { InternalTokenGuard } from './internal-token.guard';

@Controller('internal/health')
export class InternalHealthController {
  @Get()
  health(): { status: string; service: string } {
    return { status: 'ok', service: 'dvcloud-internal' };
  }
}

// Управление людьми. Вызывается только локальной админкой.
@Controller('internal/users')
@UseGuards(InternalTokenGuard)
export class InternalUsersController {
  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditService,
    private readonly dvauth: DvAuthClient,
  ) {}

  @Get()
  async list(): Promise<{ users: (PublicUser & { twoFactor: boolean })[] }> {
    const on = new Set(this.dvauth.enabled ? (await this.dvauth.call<{ subjects: string[] }>('GET', '/v1/subjects')).subjects : []);
    return { users: (await this.users.list()).map((u) => ({ ...toPublic(u), twoFactor: on.has(u.id) })) };
  }

  @Post()
  async create(@Body() body: unknown, @Req() req: Request): Promise<{ user: PublicUser; password?: string }> {
    requireJson(req);
    const o = asObject(body);
    const { user, generatedPassword } = await this.users.create(
      strField(o, 'login', 1, 64),
      strField(o, 'displayName', 1, 64),
      optStrField(o, 'password', 1, 200),
    );
    await this.audit.write('user.create', user.login);
    return { user: toPublic(user), password: generatedPassword };
  }

  @Patch(':login')
  async update(@Param('login') login: string, @Body() body: unknown, @Req() req: Request): Promise<{ user: PublicUser }> {
    requireJson(req);
    const o = asObject(body);
    const patch: { disabled?: boolean; quotaBytes?: number | null } = {};
    if (o.disabled !== undefined) {
      if (typeof o.disabled !== 'boolean') throw new BadRequestException('Поле disabled: true или false');
      patch.disabled = o.disabled;
    }
    if (o.quotaBytes !== undefined) {
      if (o.quotaBytes !== null && (!Number.isSafeInteger(o.quotaBytes) || (o.quotaBytes as number) < 0)) {
        throw new BadRequestException('Поле quotaBytes: целое число байт или null');
      }
      patch.quotaBytes = o.quotaBytes as number | null;
    }
    const user = await this.users.update(login, patch);
    await this.audit.write('user.update', login, patch);
    return { user: toPublic(user) };
  }

  @Post(':login/reset-password')
  @HttpCode(200)
  async resetPassword(@Param('login') login: string, @Body() body: unknown, @Req() req: Request): Promise<{ password?: string }> {
    requireJson(req);
    const { generatedPassword } = await this.users.resetPassword(login, optStrField(asObject(body), 'password', 1, 200));
    await this.audit.write('user.reset-password', login);
    return { password: generatedPassword };
  }

  // Человек потерял телефон и запасные коды: второй фактор снимается в DV Auth, все сессии закрываются.
  @Post(':login/reset-2fa')
  @HttpCode(200)
  async reset2fa(@Param('login') login: string): Promise<{ ok: true }> {
    const user = await this.users.findByLogin(login);
    if (!user) throw new NotFoundException('Нет такого человека');
    if (this.dvauth.enabled) await this.dvauth.call('POST', '/v1/reset', { subject: user.id });
    await this.users.closeSessions(user.id);
    await this.audit.write('user.reset-2fa', login);
    return { ok: true };
  }
}
