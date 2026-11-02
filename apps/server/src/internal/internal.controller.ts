import { BadRequestException, Body, Controller, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
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
  ) {}

  @Get()
  async list(): Promise<{ users: PublicUser[] }> {
    return { users: (await this.users.list()).map(toPublic) };
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
}
