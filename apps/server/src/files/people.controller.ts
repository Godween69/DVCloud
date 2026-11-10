import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { SessionGuard } from '../auth/session.guard';
import { UserRow } from '../users/users.service';
import { AlbumsService } from './albums.service';
import { FileFace, Guess, PeopleService, PersonInfo } from './people.service';
import { StorageService } from './storage.service';

type Req_ = Request & { user: UserRow };

const obj = (b: unknown): Record<string, unknown> => {
  if (typeof b !== 'object' || b === null || Array.isArray(b)) throw new BadRequestException('Ожидался объект');
  return b as Record<string, unknown>;
};

// Люди и питомцы: общие для всего хранилища группы. В списке только те, кто есть на файлах самого человека, файлы только свои.
// Объединять, удалять и переименовывать названные и общие группы может только администратор.
@Controller('people')
@UseGuards(SessionGuard)
export class PeopleController {
  constructor(
    private readonly people: PeopleService,
    private readonly storage: StorageService,
    private readonly albums: AlbumsService,
  ) {}

  @Get()
  async list(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Query('hidden') hidden?: string): Promise<{ enabled: { faces: boolean; pets: boolean }; people: PersonInfo[] }> {
    res.setHeader('Cache-Control', 'no-store');
    return { enabled: await this.people.status(), people: await this.people.list(req.user.id, hidden === '1', req.user.is_admin) };
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
    const rel = await this.people.cropPath(req.user.id, id, req.user.is_admin);
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

  // «Это питомец, а не человек»: {ignored: true}. Находка перестаёт спрашиваться; питомца на фото называют как обычно.
  @Put('detections/:id/ignore')
  async ignore(@Req() req: Req_, @Param('id') id: string, @Body() body: unknown): Promise<{ petsEnabled: boolean; petsOnFile: boolean }> {
    const o = obj(body);
    if (typeof o.ignored !== 'boolean') throw new BadRequestException('ignored: да или нет');
    return this.people.setIgnored(req.user.id, id, o.ignored);
  }

  // Завести человека по находке и назвать: {detectionId, name}.
  @Post()
  async create(@Req() req: Req_, @Body() body: unknown): Promise<{ id: string }> {
    const o = obj(body);
    if (typeof o.detectionId !== 'string' || typeof o.name !== 'string') throw new BadRequestException('Нужны detectionId и name');
    return this.people.createFromDetection(req.user.id, o.detectionId, o.name);
  }

  // Сколько файлов подходит: {include: ["1","2"], exclude: ["3"]}. Обязательны все из include, никого из exclude.
  @Post('match')
  @HttpCode(200)
  async match(@Req() req: Req_, @Body() body: unknown): Promise<{ count: number }> {
    const o = obj(body);
    return { count: (await this.people.matchFiles(req.user.id, o.include, o.exclude, 1)).count };
  }

  // Создать альбом под этими условиями: {name, include, exclude}. Снимок на сегодня: новые фото сами не добавляются.
  @Post('album')
  async album(@Req() req: Req_, @Body() body: unknown): Promise<{ id: string; name: string; added: number }> {
    const o = obj(body);
    const m = await this.people.matchFiles(req.user.id, o.include, o.exclude, 20000);
    if (m.ids.length === 0) throw new BadRequestException('Под эти условия не подходит ни одного фото');
    const album = await this.albums.create(req.user.id, o.name, 'any');
    let added = 0;
    for (let i = 0; i < m.ids.length; i += 1000) added += (await this.albums.addFiles(req.user.id, album.id, m.ids.slice(i, i + 1000))).added;
    return { id: album.id, name: album.name, added };
  }

  // Очередь «Проверить догадки»: свободные лица, похожие на названного человека, но не настолько, чтобы присоединить самим.
  // Ответ «он» — PUT detections/:id {personId}, «не он» — POST reject.
  @Get('guesses')
  async guesses(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Query('limit') limit?: string): Promise<{ guesses: Guess[] }> {
    res.setHeader('Cache-Control', 'no-store');
    const n = Math.min(100, Math.max(1, Number(limit) || 24));
    return { guesses: await this.people.guesses(req.user.id, n) };
  }

  // «Не знаю»: {detectionId}. Находка пропадает из очереди догадок.
  @Post('skip')
  @HttpCode(200)
  async skip(@Req() req: Req_, @Body() body: unknown): Promise<{ ok: true }> {
    const o = obj(body);
    if (typeof o.detectionId !== 'string') throw new BadRequestException('Нужен detectionId');
    await this.people.skipDetection(req.user.id, o.detectionId);
    return { ok: true };
  }

  // «Не он» для одной находки: {detectionId, personId}.
  @Post('reject')
  @HttpCode(200)
  async reject(@Req() req: Req_, @Body() body: unknown): Promise<{ ok: true }> {
    const o = obj(body);
    if (typeof o.detectionId !== 'string' || typeof o.personId !== 'string') throw new BadRequestException('Нужны detectionId и personId');
    await this.people.rejectDetection(req.user.id, o.detectionId, o.personId);
    return { ok: true };
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
    await this.people.rename(req.user.id, id, patch, req.user.is_admin);
    return { ok: true };
  }

  // Обложка группы: {fileId: "123"} (лицо этого человека на выбранном фото) или {fileId: null} (вернуть автоматический выбор).
  @Put(':id/cover')
  async cover(@Req() req: Req_, @Param('id') id: string, @Body() body: unknown): Promise<{ ok: true }> {
    const o = obj(body);
    if (o.fileId !== null && typeof o.fileId !== 'string') throw new BadRequestException('fileId: номер файла или null');
    await this.people.setCover(req.user.id, id, o.fileId, req.user.is_admin);
    return { ok: true };
  }

  // Объединить: {from: "13"} переходит в :id.
  @Post(':id/merge')
  @HttpCode(200)
  async merge(@Req() req: Req_, @Param('id') id: string, @Body() body: unknown): Promise<{ ok: true }> {
    const o = obj(body);
    if (typeof o.from !== 'string') throw new BadRequestException('from: номер группы');
    await this.people.merge(req.user.id, id, o.from, req.user.is_admin);
    return { ok: true };
  }

  // Объединить несколько групп сразу: {into: "12", from: ["13", "14"]}.
  @Post('merge-many')
  @HttpCode(200)
  async mergeMany(@Req() req: Req_, @Body() body: unknown): Promise<{ merged: number }> {
    const o = obj(body);
    if (typeof o.into !== 'string' || !Array.isArray(o.from) || !o.from.every((x) => typeof x === 'string')) throw new BadRequestException('Нужны into (номер группы) и from (список номеров)');
    return { merged: await this.people.mergeMany(req.user.id, o.into, o.from as string[], req.user.is_admin) };
  }

  @Delete(':id')
  async remove(@Req() req: Req_, @Param('id') id: string): Promise<{ ok: true }> {
    await this.people.remove(req.user.id, id, req.user.is_admin);
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
