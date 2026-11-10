import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DvAuthClient } from '../auth/dvauth.client';
import { AuditService } from '../db/audit.service';
import { asObject, optStrField, requireJson, strField } from '../http';
import { PublicUser, toPublic, UsersService } from '../users/users.service';
import { AdminAlbum, AdminFile, AdminStorageService, QuotaRequest } from '../files/admin-storage.service';
import { AdminDuplicatesService, DupReport } from '../files/admin-duplicates.service';
import { InternalTokenGuard } from './internal-token.guard';
import { AdminMediaService, ClearTarget, DatesJob, DirStat, MediaOverview } from '../files/admin-media.service';
import { MediaSettings, parseMediaPatch } from '../files/media-settings';
import { AdminFace, AdminGroup, FaceJob, PeopleService } from '../files/people.service';
import { StorageService } from '../files/storage.service';
import { BackupJob, BackupService, BackupStatus, parseBackupPatch } from '../files/backup.service';

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
      o.isChild === true,
    );
    await this.audit.write('user.create', user.login, o.isChild === true ? { child: true } : undefined);
    return { user: toPublic(user), password: generatedPassword };
  }

  @Patch(':login')
  async update(@Param('login') login: string, @Body() body: unknown, @Req() req: Request): Promise<{ user: PublicUser }> {
    requireJson(req);
    const o = asObject(body);
    const patch: { disabled?: boolean; quotaBytes?: number | null; isChild?: boolean } = {};
    if (o.isChild !== undefined) {
      if (typeof o.isChild !== 'boolean') throw new BadRequestException('Поле isChild: true или false');
      patch.isChild = o.isChild;
    }
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
    private readonly dups: AdminDuplicatesService,
    private readonly audit: AuditService,
  ) {}

  @Get('stats')
  stats() {
    return this.admin.stats();
  }

  @Get('files/orphans')
  async orphans(@Query('limit') limit?: string): Promise<{ orphans: Awaited<ReturnType<AdminStorageService['orphans']>> }> {
    const n = limit === undefined ? 200 : Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw new BadRequestException('limit: от 1 до 1000');
    return { orphans: await this.admin.orphans(n) };
  }

  // Стереть сразу все файлы без владельца: тело {confirm: <число файлов, показанное на экране>}.
  @Post('files/orphans/purge')
  @HttpCode(200)
  async purgeOrphans(@Body() body: unknown, @Req() req: Request): Promise<{ count: number; bytes: number; skipped: number }> {
    requireJson(req);
    const c = asObject(body).confirm;
    if (typeof c !== 'number' || !Number.isInteger(c) || c < 0) throw new BadRequestException('confirm: целое число');
    const r = await this.admin.purgeOrphans(c);
    await this.audit.write('file.purge-orphans', 'orphans', r);
    return r;
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

  // ── Дубликаты по всему хранилищу (поиск идёт сам в фоне) ──
  @Get('duplicates')
  duplicates(@Query('offset') offset?: string, @Query('limit') limit?: string): DupReport {
    const n = (v: string | undefined, d: number): number => (v !== undefined && /^\d{1,6}$/.test(v) ? Number(v) : d);
    return this.dups.report(n(offset, 0), n(limit, 100));
  }

  @Post('duplicates/scan')
  @HttpCode(200)
  scanDuplicates(): { queued: true } {
    this.dups.request();
    return { queued: true };
  }

  // Слить дубликаты: тело { keep: "<номер файла>", drop: ["<номера лишних>"] }. Лишние стираются с диска, записи людей переключаются на оставляемый.
  @Post('duplicates/merge')
  @HttpCode(200)
  async mergeDuplicates(@Body() body: unknown, @Req() req: Request): Promise<{ merged: number; removedFiles: number; bytes: number }> {
    requireJson(req);
    const o = asObject(body);
    const keep = strField(o, 'keep', 1, 18);
    const r = await this.dups.merge(keep, o.drop);
    await this.audit.write('files.merge-duplicates', keep, { drop: o.drop, ...r });
    return r;
  }

  // Применить решения по группам (в фоне). Тело {decisions: [{group, keep: [номера файлов, которые оставить]}]}.
  @Post('duplicates/apply')
  @HttpCode(200)
  async applyDuplicates(@Body() body: unknown, @Req() req: Request): Promise<{ started: number }> {
    requireJson(req);
    const r = await this.dups.apply(asObject(body).decisions);
    await this.audit.write('files.apply-duplicates', 'duplicates', r);
    return r;
  }

  // Сейф: альбомы, забранные у владельцев. Пароль админки проверяет админка, до этого порта доходят только подтверждённые действия.
  @Get('vault')
  async vault() {
    return { albums: await this.admin.vaultList() };
  }

  @Post('albums/:id/to-vault')
  @HttpCode(200)
  async toVault(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    requireJson(req);
    const r = await this.admin.toVault(id, asObject(body).note);
    await this.audit.write('vault.put', id, r);
    return r;
  }

  @Post('vault/:id/return')
  @HttpCode(200)
  async vaultReturn(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    requireJson(req);
    const r = await this.admin.vaultReturn(id, asObject(body).login);
    await this.audit.write('vault.return', id, r);
    return r;
  }

  @Delete('vault/:id')
  async vaultErase(@Param('id') id: string) {
    const r = await this.admin.vaultErase(id);
    await this.audit.write('vault.erase', id, r);
    return r;
  }

  @Get('albums')
  async albums(): Promise<{ albums: AdminAlbum[] }> {
    return { albums: await this.admin.albums() };
  }

  // Альбомы, удалённые людьми у себя (админ может вернуть или стереть).
  @Get('albums-deleted')
  async deletedAlbums(): Promise<{ albums: AdminAlbum[] }> {
    return { albums: await this.admin.deletedAlbums() };
  }

  @Post('albums/:id/restore')
  @HttpCode(200)
  async restoreAlbum(@Param('id') id: string): Promise<{ name: string }> {
    const r = await this.admin.restoreAlbum(id);
    await this.audit.write('album.restore', id, { name: r.name });
    return r;
  }

  @Delete('albums-deleted/:id')
  async purgeAlbum(@Param('id') id: string): Promise<{ ok: true }> {
    await this.admin.purgeAlbum(id);
    await this.audit.write('album.purge', id, {});
    return { ok: true };
  }

  @Get('albums/:id/transfer-preview')
  async transferPreview(@Param('id') id: string): Promise<{ files: number; inOtherAlbums: number; owner: string }> {
    return this.admin.transferPreview(id);
  }

  @Post('albums/:id/transfer')
  @HttpCode(200)
  async transfer(@Param('id') id: string, @Body() body: unknown, @Req() req: Request): Promise<{ albumId: string; linked: number; removedFromOwner: number }> {
    requireJson(req);
    const o = asObject(body);
    const login = strField(o, 'login', 1, 64);
    const r = await this.admin.transferAlbum(id, login, o.move === true);
    await this.audit.write('album.transfer', id, { login, move: o.move === true, linked: r.linked, removedFromOwner: r.removedFromOwner });
    return r;
  }

  // ── Просмотр всех файлов (только чтение, без журнала: так решил владелец) ──

  @Get('browse/files')
  async browse(@Query('login') login?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('q') q?: string, @Query('album') album?: string, @Query('limit') limit?: string, @Query('before') before?: string): Promise<{ files: AdminFile[]; next: string | null; total: number }> {
    const n = limit === undefined ? 60 : Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 200) throw new BadRequestException('limit: от 1 до 200');
    const s = (v?: string) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
    return this.admin.browse({ login: s(login), from: s(from), to: s(to), q: s(q)?.slice(0, 100), albumId: s(album), limit: n, before: s(before) });
  }

  // Карточка файла и соседи под тем же фильтром (для просмотрщика админки).
  @Get('browse/files/:id/info')
  async browseInfo(@Param('id') id: string, @Query('login') login?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('q') q?: string, @Query('album') album?: string): ReturnType<AdminStorageService['fileInfo']> {
    const s = (v?: string) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
    return this.admin.fileInfo(id, { login: s(login), from: s(from), to: s(to), q: s(q)?.slice(0, 100), albumId: s(album) });
  }

  // Исправить дату снимка у файла (по жалобе человека): { takenAt: ISO-время UTC }. Пересчёт дат такой файл больше не трогает.
  @Patch('browse/files/:id/taken')
  async setTaken(@Param('id') id: string, @Body() body: unknown, @Req() req: Request): Promise<{ takenAt: string }> {
    requireJson(req);
    const takenAt = await this.admin.setTaken(id, asObject(body).takenAt);
    await this.audit.write('file.taken', id, { takenAt });
    return { takenAt };
  }

  // Миниатюра, если она уже построена людьми (новых не строим: внутренний порт не запускает фоновых работ). Иначе 404.
  @Get('browse/files/:id/thumb')
  async browseThumb(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const b = await this.admin.blobOf(id);
    if (!b) throw new NotFoundException('Файл не найден');
    res.setHeader('Content-Type', 'image/webp');
    const opts = { root: this.admin.root, dotfiles: 'deny' as const, headers: { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, max-age=3600' } };
    // Единая миниатюра файла лежит в thumbs-fit; прежняя квадратная (если новой ещё нет) в thumbs.
    res.sendFile(`thumbs-fit/${b.blobId}.webp`, opts, (err) => {
      if (!err || res.headersSent) return;
      res.sendFile(`thumbs/${b.blobId}.webp`, opts, (err2) => {
        if (err2 && !res.headersSent) res.status(404).json({ message: 'Миниатюры нет' });
      });
    });
  }

  // Картинка покрупнее для приближения при сравнении дубликатов: превью для просмотра, а если его ещё нет, сам файл.
  @Get('browse/files/:id/preview')
  async browsePreview(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const b = await this.admin.blobOf(id);
    if (!b) throw new NotFoundException('Файл не найден');
    if (!/^image\/[a-z0-9.+-]+$/i.test(b.mime)) throw new BadRequestException('Приближение только для фото');
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, max-age=600' };
    res.setHeader('Content-Type', 'image/webp');
    res.sendFile(`previews/${b.blobId}.webp`, { root: this.admin.root, dotfiles: 'deny', headers }, (err) => {
      if (!err || res.headersSent) return;
      res.setHeader('Content-Type', b.mime);
      res.sendFile(b.path, { root: this.admin.root, dotfiles: 'deny', headers }, (err2) => {
        if (err2 && !res.headersSent) res.status(404).json({ message: 'Файла нет на диске' });
      });
    });
  }

  // Сам файл целиком (фото или видео), как он лежит на диске.
  @Get('browse/files/:id/original')
  async browseOriginal(@Param('id') id: string, @Query('dl') dl: string | undefined, @Res() res: Response): Promise<void> {
    const b = await this.admin.blobOf(id);
    if (!b) throw new NotFoundException('Файл не найден');
    if (!/^(image|video)\/[a-z0-9.+-]+$/i.test(b.mime)) throw new BadRequestException('Показываются только фото и видео');
    res.setHeader('Content-Type', b.mime);
    if (dl === '1') res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(b.name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`);
    res.sendFile(b.path, { root: this.admin.root, dotfiles: 'deny', headers: { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'no-store' } }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ message: 'Файла нет на диске' });
    });
  }

  // ── Раздача альбомов ──

  @Get('albums/:id/shares')
  async albumShares(@Param('id') id: string): Promise<{ logins: string[] }> {
    return { logins: await this.admin.albumShares(id) };
  }

  @Put('albums/:id/shares/:login')
  async share(@Param('id') id: string, @Param('login') login: string): Promise<{ ok: true }> {
    await this.admin.setShare(id, login, true);
    await this.audit.write('album.share', id, { login });
    return { ok: true };
  }

  @Delete('albums/:id/shares/:login')
  async unshare(@Param('id') id: string, @Param('login') login: string): Promise<{ ok: true }> {
    await this.admin.setShare(id, login, false);
    await this.audit.write('album.unshare', id, { login });
    return { ok: true };
  }

  @Delete('albums/:id/shares')
  async unshareAll(@Param('id') id: string): Promise<{ removed: number }> {
    const removed = await this.admin.unshareAll(id);
    await this.audit.write('album.unshare-all', id, { removed });
    return { removed };
  }

  @Post('albums/:id/share-all')
  @HttpCode(200)
  async shareAll(@Param('id') id: string): Promise<{ added: number }> {
    const added = await this.admin.shareWithAll(id);
    await this.audit.write('album.share-all', id, { added });
    return { added };
  }

  @Post('share-everything')
  @HttpCode(200)
  async shareEverything(@Body() body: unknown, @Req() req: Request): Promise<{ albums: number; links: number }> {
    requireJson(req);
    if (asObject(body).confirm !== true) throw new BadRequestException('confirm: true');
    const r = await this.admin.shareEverything();
    await this.audit.write('album.share-everything', 'all', r);
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
    private readonly people: PeopleService,
  ) {}

  // «Пересобрать группы»: безымянные автоматические группы людей собираются заново по текущей строгости.
  // Названные, скрытые и правленные вручную остаются. Идёт в фоне: ответ приходит сразу, ход виден в GET /internal/media.
  @Post('people/rebuild')
  @HttpCode(200)
  async rebuildPeople(@Req() req: Request): Promise<{ job: FaceJob }> {
    requireJson(req);
    const job = this.people.startFaceJob('rebuild');
    await this.audit.write('media.people', 'rebuild', {});
    return { job };
  }

  // Подсказка: сколько групп получилось бы при каждой строгости. Ничего не меняет, тоже в фоне.
  @Post('people/hint')
  @HttpCode(200)
  async hintPeople(@Req() req: Request): Promise<{ job: FaceJob }> {
    requireJson(req);
    return { job: this.people.startFaceJob('hint') };
  }

  @Get()
  async overview(): Promise<MediaOverview & { peopleJob: FaceJob | null }> {
    return { ...(await this.media.overview()), peopleJob: this.people.faceJob() };
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

// Резервная копия: настройки места, проверка связи, запуск по кнопке и ход.
@Controller('internal/backup')
@UseGuards(InternalTokenGuard)
export class InternalBackupController {
  constructor(
    private readonly backup: BackupService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  status(): Promise<BackupStatus> {
    return this.backup.status();
  }

  @Patch('config')
  async save(@Body() body: unknown, @Req() req: Request): Promise<BackupStatus> {
    requireJson(req);
    const next = await this.backup.saveConfig(parseBackupPatch(body));
    await this.audit.write('backup.config', next.kind, { kind: next.kind, host: next.host, path: next.path, folder: next.folder });
    return this.backup.status();
  }

  // Проверка места назначения, ничего не копирует.
  @Post('check')
  @HttpCode(200)
  async check(): Promise<{ where: string; freeBytes: number | null }> {
    return this.backup.check(await this.backup.getConfig());
  }

  @Post('start')
  @HttpCode(200)
  async start(): Promise<{ job: BackupJob }> {
    const job = await this.backup.start();
    await this.audit.write('backup.start', 'backup', {});
    return { job };
  }
}

// Вкладка «Лица» в админке: общие группы людей и питомцев всего хранилища. Здесь администратор может всё:
// называть, переименовывать, объединять, распускать, убирать отдельные лица.
@Controller('internal/faces')
@UseGuards(InternalTokenGuard)
export class InternalFacesController {
  constructor(
    private readonly people: PeopleService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  async list(@Query('kind') kind?: string, @Query('q') q?: string, @Query('unnamed') unnamed?: string, @Query('offset') offset?: string, @Query('limit') limit?: string): Promise<{ total: number; groups: AdminGroup[]; enabled: { faces: boolean; pets: boolean } }> {
    const k = kind === 'person' || kind === 'pet' ? kind : undefined;
    const r = await this.people.adminGroups({
      kind: k, q: (q ?? '').trim().slice(0, 60) || undefined, unnamed: unnamed === '1',
      offset: Math.max(0, Math.min(1_000_000, Number(offset) || 0)), limit: Math.max(1, Math.min(100, Number(limit) || 24)),
    });
    return { ...r, enabled: await this.people.status() };
  }

  // Вырезка лица для больших рамок (любая находка).
  @Get('detections/:id/crop')
  async crop(@Res() res: Response, @Param('id') id: string): Promise<void> {
    const rel = await this.people.cropPath('0', id, true);
    res.setHeader('Content-Type', 'image/webp');
    res.sendFile(rel, {
      root: this.storage.root,
      dotfiles: 'deny',
      headers: { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, max-age=31536000, immutable' },
    }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ message: 'Вырезки нет' });
    });
  }

  @Get(':id')
  async one(@Param('id') id: string, @Query('offset') offset?: string, @Query('limit') limit?: string): Promise<{ group: AdminGroup; total: number; faces: AdminFace[] }> {
    return this.people.adminFaces(id, Math.max(1, Math.min(120, Number(limit) || 48)), Math.max(0, Number(offset) || 0));
  }

  @Patch(':id')
  async rename(@Req() req: Request, @Param('id') id: string): Promise<{ ok: true }> {
    requireJson(req);
    const o = asObject(req.body);
    if (o.name !== null && typeof o.name !== 'string') throw new BadRequestException('name: строка или null');
    await this.people.rename('0', id, { name: o.name as string | null }, true);
    await this.audit.write('faces.rename', id, { name: o.name });
    return { ok: true };
  }

  @Post('merge')
  @HttpCode(200)
  async merge(@Req() req: Request): Promise<{ merged: number }> {
    requireJson(req);
    const o = asObject(req.body);
    if (typeof o.into !== 'string' || !Array.isArray(o.from) || !o.from.every((x) => typeof x === 'string')) throw new BadRequestException('Нужны into и from');
    const merged = await this.people.mergeMany('0', o.into, o.from as string[], true);
    await this.audit.write('faces.merge', o.into, { from: o.from });
    return { merged };
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<{ ok: true }> {
    await this.people.remove('0', id, true);
    await this.audit.write('faces.dissolve', id, {});
    return { ok: true };
  }

  @Post(':id/remove-face')
  @HttpCode(200)
  async removeFace(@Req() req: Request, @Param('id') id: string): Promise<{ ok: true }> {
    requireJson(req);
    const o = asObject(req.body);
    if (typeof o.detectionId !== 'string') throw new BadRequestException('Нужен detectionId');
    await this.people.adminRemoveFace(id, o.detectionId);
    await this.audit.write('faces.remove-face', id, { detectionId: o.detectionId });
    return { ok: true };
  }
}
