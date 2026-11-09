import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { SessionGuard } from '../auth/session.guard';
import { UserRow } from '../users/users.service';
import { FileFace, PeopleService, PersonInfo } from './people.service';
import { StorageService } from './storage.service';

type Req_ = Request & { user: UserRow };

const obj = (b: unknown): Record<string, unknown> => {
  if (typeof b !== 'object' || b === null || Array.isArray(b)) throw new BadRequestException('Ожидался объект');
  return b as Record<string, unknown>;
};

// Люди и питомцы человека: список групп, имена, объединение, лица на фото. Всё только про СВОИ файлы и СВОИ группы.
@Controller('people')
@UseGuards(SessionGuard)
export class PeopleController {
  constructor(
    private readonly people: PeopleService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  async list(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Query('hidden') hidden?: string): Promise<{ enabled: { faces: boolean; pets: boolean }; people: PersonInfo[] }> {
    res.setHeader('Cache-Control', 'no-store');
    return { enabled: await this.people.status(), people: await this.people.list(req.user.id, hidden === '1') };
  }

  // Рамки лиц и питомцев на одном файле (для просмотрщика).
  @Get('file/:fileId')
  async ofFile(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Param('fileId') fileId: string): Promise<{ faces: FileFace[] }> {
    res.setHeader('Cache-Control', 'no-store');
    return { faces: await this.people.facesOfFile(req.user.id, fileId) };
  }

  // Обложка: вырезка лица или питомца. Находка не меняется, поэтому браузер хранит вырезку год.
  @Get('detections/:id/crop')
  async crop(@Req() req: Req_, @Res() res: Response, @Param('id') id: string): Promise<void> {
    const rel = await this.people.cropPath(req.user.id, id);
    res.setHeader('Content-Type', 'image/webp');
    res.sendFile(rel, {
      root: this.storage.root,
      dotfiles: 'deny',
      headers: { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, max-age=31536000, immutable' },
    }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ message: 'Вырезки нет' });
    });
  }

  // Назначить находку человеку или снять назначение: {personId: "12"} или {personId: null}.
  @Put('detections/:id')
  async assign(@Req() req: Req_, @Param('id') id: string, @Body() body: unknown): Promise<{ ok: true }> {
    const o = obj(body);
    if (o.personId !== null && typeof o.personId !== 'string') throw new BadRequestException('personId: номер группы или null');
    await this.people.assign(req.user.id, id, o.personId);
    return { ok: true };
  }

  // Завести человека по находке и назвать: {detectionId, name}.
  @Post()
  async create(@Req() req: Req_, @Body() body: unknown): Promise<{ id: string }> {
    const o = obj(body);
    if (typeof o.detectionId !== 'string' || typeof o.name !== 'string') throw new BadRequestException('Нужны detectionId и name');
    return this.people.createFromDetection(req.user.id, o.detectionId, o.name);
  }

  @Patch(':id')
  async patch(@Req() req: Req_, @Param('id') id: string, @Body() body: unknown): Promise<{ ok: true }> {
    const o = obj(body);
    const patch: { name?: string | null; hidden?: boolean } = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === 'name') {
        if (v !== null && typeof v !== 'string') throw new BadRequestException('name: строка или null');
        patch.name = v as string | null;
      } else if (k === 'hidden') {
        if (typeof v !== 'boolean') throw new BadRequestException('hidden: да или нет');
        patch.hidden = v;
      } else throw new BadRequestException(`Неизвестное поле: ${k}`);
    }
    await this.people.rename(req.user.id, id, patch);
    return { ok: true };
  }

  // Обложка группы: {fileId: "123"} (лицо этого человека на выбранном фото) или {fileId: null} (вернуть автоматический выбор).
  @Put(':id/cover')
  async cover(@Req() req: Req_, @Param('id') id: string, @Body() body: unknown): Promise<{ ok: true }> {
    const o = obj(body);
    if (o.fileId !== null && typeof o.fileId !== 'string') throw new BadRequestException('fileId: номер файла или null');
    await this.people.setCover(req.user.id, id, o.fileId);
    return { ok: true };
  }

  // Объединить: {from: "13"} переходит в :id.
  @Post(':id/merge')
  @HttpCode(200)
  async merge(@Req() req: Req_, @Param('id') id: string, @Body() body: unknown): Promise<{ ok: true }> {
    const o = obj(body);
    if (typeof o.from !== 'string') throw new BadRequestException('from: номер группы');
    await this.people.merge(req.user.id, id, o.from);
    return { ok: true };
  }

  // Объединить несколько групп сразу: {into: "12", from: ["13", "14"]}.
  @Post('merge-many')
  @HttpCode(200)
  async mergeMany(@Req() req: Req_, @Body() body: unknown): Promise<{ merged: number }> {
    const o = obj(body);
    if (typeof o.into !== 'string' || !Array.isArray(o.from) || !o.from.every((x) => typeof x === 'string')) throw new BadRequestException('Нужны into (номер группы) и from (список номеров)');
    return { merged: await this.people.mergeMany(req.user.id, o.into, o.from as string[]) };
  }

  @Delete(':id')
  async remove(@Req() req: Req_, @Param('id') id: string): Promise<{ ok: true }> {
    await this.people.remove(req.user.id, id);
    return { ok: true };
  }

  // «Это не они» для многих файлов сразу: {fileIds: ["1","2"]}.
  @Post(':id/not-them')
  async notThemMany(@Req() req: Req_, @Param('id') id: string, @Body() body: unknown): Promise<{ removed: number }> {
    return { removed: await this.people.notThemMany(req.user.id, id, obj(body).fileIds) };
  }

  // «Это не он»: убрать человека с этого файла.
  @Delete(':id/files/:fileId')
  async notThem(@Req() req: Req_, @Param('id') id: string, @Param('fileId') fileId: string): Promise<{ removed: number }> {
    return { removed: await this.people.notThem(req.user.id, id, fileId) };
  }
}
