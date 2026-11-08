import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { DvAuthClient } from '../auth/dvauth.client';
import { AuditService } from '../db/audit.service';
import { asObject, optStrField, requireJson, strField } from '../http';
import { PublicUser, toPublic, UsersService } from '../users/users.service';
import { AdminAlbum, AdminStorageService, QuotaRequest } from '../files/admin-storage.service';
import { InternalTokenGuard } from './internal-token.guard';
import { AdminMediaService, ClearTarget, DatesJob, DirStat, MediaOverview } from '../files/admin-media.service';
import { MediaSettings, parseMediaPatch } from '../files/media-settings';

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
  async list(): Promise<{ users: (PublicUser & { twoFactor: boolean; usedBytes: number })[] }> {
    const on = new Set(this.dvauth.enabled ? (await this.dvauth.call<{ subjects: string[] }>('GET', '/v1/subjects')).subjects : []);
    const used = await this.users.usedByOwner();
    return { users: (await this.users.list()).map((u) => ({ ...toPublic(u), twoFactor: on.has(u.id), usedBytes: used.get(u.id) ?? 0 })) };
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

// Хранение для администратора: файлы без владельца, физическое удаление, альбомы, просьбы о месте.
@Controller('internal')
@UseGuards(InternalTokenGuard)
export class InternalStorageController {
  constructor(
    private readonly admin: AdminStorageService,
    private readonly audit: AuditService,
  ) {}

  @Get('stats')
  stats() {
    return this.admin.stats();
  }

  @Get('files/orphans')
  async orphans(@Query('limit') limit?: string): Promise<{ orphans: { id: string; name: string; size: number; createdAt: string }[] }> {
    const n = limit === undefined ? 200 : Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw new BadRequestException('limit: от 1 до 1000');
    return { orphans: await this.admin.orphans(n) };
  }

  // Физическое удаление: единственное место, где файл стирается с диска.
  @Post('files/:id/purge')
  @HttpCode(200)
  async purge(@Param('id') id: string): Promise<{ links: number; bytes: number }> {
    const r = await this.admin.purgeBlob(id);
    await this.audit.write('file.purge', id, r);
    return r;
  }

  @Post('files/:id/adopt')
  @HttpCode(200)
  async adopt(@Param('id') id: string, @Body() body: unknown, @Req() req: Request): Promise<{ fileId: string }> {
    requireJson(req);
    const login = strField(asObject(body), 'login', 1, 64);
    const f = await this.admin.adopt(id, login);
    await this.audit.write('file.adopt', id, { login });
    return { fileId: f.id };
  }

  // Убрать лишние физические копии одного содержимого (проверка по SHA-256). {apply:false} только проверяет.
  @Post('files/dedupe')
  @HttpCode(200)
  async dedupe(@Body() body: unknown, @Req() req: Request) {
    requireJson(req);
    const o = asObject(body);
    const limit = o.limit === undefined ? 20 : Number(o.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new BadRequestException('limit: от 1 до 500');
    const r = await this.admin.dedupeExtras(limit, o.apply === true);
    if (o.apply === true) await this.audit.write('files.dedupe', 'extras', { removed: r.removed, freedBytes: r.freedBytes });
    return r;
  }

  @Get('albums')
  async albums(): Promise<{ albums: AdminAlbum[] }> {
    return { albums: await this.admin.albums() };
  }

  @Post('albums/:id/transfer')
  @HttpCode(200)
  async transfer(@Param('id') id: string, @Body() body: unknown, @Req() req: Request): Promise<{ albumId: string; linked: number }> {
    requireJson(req);
    const o = asObject(body);
    const login = strField(o, 'login', 1, 64);
    const r = await this.admin.transferAlbum(id, login, o.move === true);
    await this.audit.write('album.transfer', id, { login, move: o.move === true, linked: r.linked });
    return r;
  }

  @Delete('albums/:id')
  async deleteAlbum(@Param('id') id: string): Promise<{ ok: true }> {
    await this.admin.deleteAlbum(id);
    await this.audit.write('album.delete', id, {});
    return { ok: true };
  }

  @Delete('users/:login')
  async deleteUser(@Param('login') login: string, @Query('force') force?: string): Promise<{ links: number }> {
    const r = await this.admin.deleteUser(login, force === '1');
    await this.audit.write('user.delete', login, r);
    return r;
  }

  @Get('quota-requests')
  async quotaRequests(): Promise<{ requests: QuotaRequest[] }> {
    return { requests: await this.admin.quotaRequests() };
  }

  @Post('quota-requests/:id/resolve')
  @HttpCode(200)
  async resolve(@Param('id') id: string): Promise<{ ok: true }> {
    await this.admin.resolveQuotaRequest(id);
    return { ok: true };
  }
}

// Настройки превью и видео, счётчики и очистка производных файлов.
@Controller('internal/media')
@UseGuards(InternalTokenGuard)
export class InternalMediaController {
  constructor(
    private readonly media: AdminMediaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  overview(): Promise<MediaOverview> {
    return this.media.overview();
  }

  @Get('dates')
  dates(): { job: DatesJob | null } {
    return { job: this.media.datesStatus() };
  }

  // Пересчёт дат съёмки у загруженных файлов. apply=false только проверяет.
  @Post('dates')
  @HttpCode(200)
  async startDates(@Body() body: unknown, @Req() req: Request): Promise<{ job: DatesJob }> {
    requireJson(req);
    const o = asObject(body);
    if (typeof o.apply !== 'boolean') throw new BadRequestException('apply: да или нет');
    const job = await this.media.startDates(o.apply);
    await this.audit.write('media.dates', o.apply ? 'apply' : 'check', { total: job.total });
    return { job };
  }

  @Patch('settings')
  async save(@Body() body: unknown, @Req() req: Request): Promise<{ settings: MediaSettings; cleared: ClearTarget[] }> {
    requireJson(req);
    const patch = parseMediaPatch(body);
    if (Object.keys(patch).length === 0) throw new BadRequestException('Нечего менять');
    const r = await this.media.save(patch);
    await this.audit.write('media.settings', 'media', { patch, cleared: r.cleared });
    return r;
  }

  @Post('clear')
  @HttpCode(200)
  async clear(@Body() body: unknown, @Req() req: Request): Promise<DirStat> {
    requireJson(req);
    const what = strField(asObject(body), 'what', 1, 16);
    const r = await this.media.clear(what);
    await this.audit.write('media.clear', what, { files: r.files, bytes: r.bytes });
    return r;
  }
}
