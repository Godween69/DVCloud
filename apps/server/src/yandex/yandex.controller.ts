import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { SessionGuard } from '../auth/session.guard';
import { asObject, requireJson } from '../http';
import { UserRow } from '../users/users.service';
import { YandexService, YandexStatus } from './yandex.service';

type Req_ = Request & { user: UserRow };

const noStore = (res: Response): void => void res.setHeader('Cache-Control', 'no-store');

// Раздел «Яндекс Диск» человека. Всё только про его собственный подключённый аккаунт: чужой не виден и не доступен.
@Controller('yandex')
@UseGuards(SessionGuard)
export class YandexController {
  constructor(private readonly yandex: YandexService) {}

  @Get()
  async status(@Req() req: Req_, @Res({ passthrough: true }) res: Response): Promise<YandexStatus> {
    noStore(res);
    return this.yandex.status(req.user);
  }

  // Вход по QR: start даёт номер входа, qr отдаёт картинку, status спрашивают раз в пару секунд.
  @Post('connect')
  @HttpCode(200)
  async connect(@Req() req: Req_, @Res({ passthrough: true }) res: Response): Promise<{ id: string }> {
    requireJson(req);
    noStore(res);
    return this.yandex.connectStart(req.user);
  }

  @Get('connect/:id/qr')
  async qr(@Req() req: Req_, @Res() res: Response, @Param('id') id: string): Promise<void> {
    if (!/^[0-9a-f]{16,64}$/.test(id)) throw new BadRequestException('Неверный номер входа');
    const png = await this.yandex.connectQr(req.user, id);
    res.setHeader('Cache-Control', 'no-store');
    if (!png) {
      res.status(204).end();
      return;
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(png);
  }

  @Get('connect/:id')
  async connectStatus(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Param('id') id: string): Promise<{ state: 'waiting' | 'done' | 'failed'; note?: string }> {
    if (!/^[0-9a-f]{16,64}$/.test(id)) throw new BadRequestException('Неверный номер входа');
    noStore(res);
    return this.yandex.connectStatus(req.user, id);
  }

  @Delete()
  @HttpCode(200)
  async disconnect(@Req() req: Req_): Promise<{ ok: true }> {
    await this.yandex.disconnect(req.user);
    return { ok: true };
  }

  @Post('list')
  @HttpCode(200)
  async list(@Req() req: Req_): Promise<{ ok: true }> {
    requireJson(req);
    await this.yandex.startList(req.user);
    return { ok: true };
  }

  // Тело: { years?: (число|null)[], retryFailed?: boolean, intoAlbum?: boolean }. Без years забирается всё.
  @Post('import')
  @HttpCode(200)
  async startImport(@Req() req: Req_, @Body() body: unknown): Promise<{ queued: number }> {
    requireJson(req);
    const o = asObject(body ?? {});
    let years: (number | null)[] | undefined;
    if (o.years !== undefined) {
      if (!Array.isArray(o.years) || o.years.length > 100 || o.years.some((y) => y !== null && !(Number.isInteger(y) && y >= 1990 && y <= 2100))) throw new BadRequestException('years: список годов (или null для файлов без даты)');
      years = o.years as (number | null)[];
    }
    if (o.intoAlbum !== undefined && typeof o.intoAlbum !== 'boolean') throw new BadRequestException('intoAlbum: да или нет');
    return this.yandex.startImport(req.user, { years, retryFailed: o.retryFailed === true, intoAlbum: o.intoAlbum as boolean | undefined });
  }

  // Тело: { autoSync?: boolean, autoImport?: boolean, syncDays?: 1 | 7 | 30 }. Ночная сверка (как часто) и автозабор нового.
  @Post('settings')
  @HttpCode(200)
  async settings(@Req() req: Req_, @Body() body: unknown): Promise<{ ok: true }> {
    requireJson(req);
    const o = asObject(body ?? {});
    for (const k of ['autoSync', 'autoImport']) if (o[k] !== undefined && typeof o[k] !== 'boolean') throw new BadRequestException(`${k}: да или нет`);
    if (o.syncDays !== undefined && o.syncDays !== 1 && o.syncDays !== 7 && o.syncDays !== 30) throw new BadRequestException('syncDays: 1 (каждую ночь), 7 (раз в неделю) или 30 (раз в месяц)');
    await this.yandex.setSettings(req.user, { autoSync: o.autoSync as boolean | undefined, autoImport: o.autoImport as boolean | undefined, syncDays: o.syncDays as number | undefined });
    return { ok: true };
  }

  @Post('resume')
  @HttpCode(200)
  async resume(@Req() req: Req_): Promise<{ ok: true }> {
    requireJson(req);
    await this.yandex.resumeImport(req.user);
    return { ok: true };
  }

  @Post('pause')
  @HttpCode(200)
  async pause(@Req() req: Req_): Promise<{ ok: true }> {
    requireJson(req);
    await this.yandex.pauseImport(req.user);
    return { ok: true };
  }

  @Get('items')
  async items(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Query('state') state?: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    noStore(res);
    return this.yandex.items(req.user, state, Number(limit) || 100, Number(offset) || 0);
  }
}
