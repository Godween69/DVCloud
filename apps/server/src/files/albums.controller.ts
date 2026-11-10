import { BadRequestException, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { pipeline } from 'node:stream';
import { Readable } from 'node:stream';
import { SessionGuard } from '../auth/session.guard';
import { asObject, requireJson } from '../http';
import { UserRow } from '../users/users.service';
import { AlbumsService, AlbumSuggestion, parseIds, PublicAlbum, PublicPerson, zipFileName } from './albums.service';
import { FilesService, PublicFile, toPublicFile } from './files.service';
import { contentDisposition } from './names';
import { zipSize, zipStream } from './zip';
import type { FileRow } from './files.service';

type Req_ = Request & { user: UserRow };

async function sendZip(albums: AlbumsService, res: Response, title: string, rows: FileRow[]): Promise<void> {
  const entries = await albums.zipEntries(rows);
  if (entries.length === 0) {
    res.status(404).json({ message: 'В подборке нет файлов' });
    return;
  }
  res.status(200);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Length', String(zipSize(entries)));
  res.setHeader('Content-Disposition', contentDisposition(zipFileName(title), true));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  // Если файл изменился или клиент ушёл, соединение обрывается: неполный архив не выдаётся за целый.
  pipeline(Readable.from(zipStream(entries)), res, () => res.destroy());
}

@Controller('albums')
@UseGuards(SessionGuard)
export class AlbumsController {
  constructor(
    private readonly albums: AlbumsService,
    private readonly files: FilesService,
  ) {}

  @Get()
  async list(@Req() req: Req_, @Res({ passthrough: true }) res: Response): Promise<{ albums: PublicAlbum[] }> {
    res.setHeader('Cache-Control', 'no-store');
    return { albums: await this.albums.list(req.user.id) };
  }

  @Post()
  async create(@Req() req: Req_, @Res({ passthrough: true }) res: Response): Promise<{ album: PublicAlbum }> {
    requireJson(req);
    res.setHeader('Cache-Control', 'no-store');
    const body = asObject(req.body);
    return { album: await this.albums.create(req.user.id, body.name, body.kind) };
  }

  // В каких альбомах лежит файл. album — первый из них (для старых клиентов), albums — все.
  @Get('of-file/:fileId')
  async ofFile(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Param('fileId') fileId: string): Promise<{ album: { id: string; name: string } | null; albums: { id: string; name: string }[] }> {
    res.setHeader('Cache-Control', 'no-store');
    const albums = await this.albums.albumsOfFile(req.user.id, fileId);
    return { album: albums[0] ?? null, albums };
  }

  // Конструктор альбома: границы дат для календаря, подсчёт «подходит N» и создание.
  // Тело: {from?, to?, source: all|photos|videos|screenshots|albums, albumIds?, include?, exclude?, name?}
  @Get('builder/bounds')
  async builderBounds(@Req() req: Req_, @Res({ passthrough: true }) res: Response): Promise<{ min: string | null; max: string }> {
    res.setHeader('Cache-Control', 'no-store');
    return this.albums.builderBounds(req.user.id);
  }

  @Post('builder/count')
  @HttpCode(200)
  async builderCount(@Req() req: Req_, @Res({ passthrough: true }) res: Response): Promise<{ count: number }> {
    requireJson(req);
    res.setHeader('Cache-Control', 'no-store');
    return this.albums.builderCount(req.user.id, asObject(req.body));
  }

  @Post('builder/create')
  @HttpCode(200)
  async builderCreate(@Req() req: Req_, @Res({ passthrough: true }) res: Response): Promise<{ album: PublicAlbum; added: number }> {
    requireJson(req);
    res.setHeader('Cache-Control', 'no-store');
    return this.albums.builderCreate(req.user.id, asObject(req.body));
  }

  // Окно удаления из альбома: сколько из выбранных файлов есть и в других альбомах. {albumId, fileIds}
  @Post('in-other')
  @HttpCode(200)
  async inOther(@Req() req: Req_, @Res({ passthrough: true }) res: Response): Promise<{ files: number; albums: { id: string; name: string }[] }> {
    requireJson(req);
    res.setHeader('Cache-Control', 'no-store');
    const o = asObject(req.body);
    if (typeof o.albumId !== 'string') throw new BadRequestException('Нужен albumId');
    return this.albums.inOtherAlbums(req.user.id, o.albumId, parseIds(o.fileIds));
  }

  // Убрать файлы из ВСЕХ своих альбомов (корзину не трогает). {fileIds}
  @Post('remove-everywhere')
  @HttpCode(200)
  async removeEverywhere(@Req() req: Req_, @Res({ passthrough: true }) res: Response): Promise<{ removed: number }> {
    requireJson(req);
    res.setHeader('Cache-Control', 'no-store');
    return { removed: await this.albums.removeFromAllAlbums(req.user.id, parseIds(asObject(req.body).fileIds)) };
  }

  // Предложенные альбомы: события по времени съёмки из файлов, которых нет ни в одном альбоме.
  @Get('suggestions')
  async suggestions(@Req() req: Req_, @Res({ passthrough: true }) res: Response): Promise<{ suggestions: Omit<AlbumSuggestion, 'fileIds'>[] }> {
    res.setHeader('Cache-Control', 'no-store');
    return { suggestions: (await this.albums.suggestions(req.user.id)).map(({ fileIds, ...rest }) => { void fileIds; return rest; }) };
  }

  // {id, name?}: создать альбом из события.
  @Post('suggestions/accept')
  @HttpCode(200)
  async acceptSuggestion(@Req() req: Req_, @Res({ passthrough: true }) res: Response): Promise<{ album: PublicAlbum; added: number }> {
    requireJson(req);
    res.setHeader('Cache-Control', 'no-store');
    const o = asObject(req.body);
    return this.albums.acceptSuggestion(req.user.id, o.id, o.name);
  }

  // {id}: «Не нужно».
  @Post('suggestions/dismiss')
  @HttpCode(200)
  async dismissSuggestion(@Req() req: Req_): Promise<{ ok: true }> {
    requireJson(req);
    await this.albums.dismissSuggestion(req.user.id, asObject(req.body).id);
    return { ok: true };
  }

  // Люди, с которыми можно делиться.
  @Get('people')
  async people(@Req() req: Req_, @Res({ passthrough: true }) res: Response): Promise<{ people: PublicPerson[] }> {
    res.setHeader('Cache-Control', 'no-store');
    return { people: await this.albums.people(req.user.id) };
  }

  @Patch(':id')
  async rename(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Param('id') id: string): Promise<{ album: PublicAlbum }> {
    requireJson(req);
    res.setHeader('Cache-Control', 'no-store');
    return { album: await this.albums.rename(req.user.id, id, asObject(req.body).name) };
  }

  // Где показывать файлы альбома: в библиотеке, фото, видео, скриншотах. Тело: { library?, photos?, videos?, screenshots? } (да/нет).
  @Patch(':id/show')
  async show(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Param('id') id: string): Promise<{ album: PublicAlbum }> {
    requireJson(req);
    res.setHeader('Cache-Control', 'no-store');
    return { album: await this.albums.setShow(req.user.id, id, req.body) };
  }

  // Звёздочка альбома. Тело: { favorite: true | false }.
  @Patch(':id/favorite')
  async favorite(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Param('id') id: string): Promise<{ album: PublicAlbum }> {
    requireJson(req);
    res.setHeader('Cache-Control', 'no-store');
    return { album: await this.albums.setFavorite(req.user.id, id, asObject(req.body).favorite) };
  }

  @Delete(':id')
  async remove(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Param('id') id: string): Promise<{ ok: true }> {
    res.setHeader('Cache-Control', 'no-store');
    await this.albums.remove(req.user.id, id);
    return { ok: true };
  }

  // Лента альбома. at: начать с месяца (2015-03, часовой пояс tz), after: догрузить новее ключа; prev: есть ли новее верхнего файла.
  @Get(':id/files')
  async feed(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Param('id') id: string, @Query('limit') limit?: string, @Query('before') before?: string, @Query('at') at?: string, @Query('tz') tz?: string, @Query('after') after?: string): Promise<{ album: PublicAlbum; files: PublicFile[]; next: string | null; prev: string | null }> {
    const lim = limit === undefined ? 100 : Number(limit);
    if (!Number.isInteger(lim) || lim < 1 || lim > 500) throw new BadRequestException('limit: от 1 до 500');
    const { album, ownerId } = await this.albums.getVisible(req.user.id, id);
    const r = await this.files.list(ownerId, { trashed: false, limit: lim, before: typeof before === 'string' ? before : undefined, albumId: album.id, at: typeof at === 'string' ? at : undefined, tz: typeof tz === 'string' ? tz : undefined, after: typeof after === 'string' ? after : undefined });
    res.setHeader('Cache-Control', 'no-store');
    return { album, files: r.files.map(toPublicFile), next: r.next, prev: r.prev };
  }

  // Оглавление альбома по месяцам для полосы времени.
  @Get(':id/timeline')
  async timeline(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Param('id') id: string, @Query('tz') tz?: string): Promise<{ months: { y: number; m: number; n: number }[] }> {
    const { album, ownerId } = await this.albums.getVisible(req.user.id, id);
    res.setHeader('Cache-Control', 'no-store');
    return { months: await this.files.timeline(ownerId, undefined, typeof tz === 'string' ? tz : 'UTC', { albumId: album.id }) };
  }

  @Get(':id/ids')
  async ids(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Param('id') id: string): Promise<{ ids: string[] }> {
    res.setHeader('Cache-Control', 'no-store');
    return { ids: await this.albums.fileIds(req.user.id, id) };
  }

  @Post(':id/add')
  @HttpCode(200)
  async add(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Param('id') id: string): Promise<{ added: number; rejected: number }> {
    requireJson(req);
    res.setHeader('Cache-Control', 'no-store');
    return this.albums.addFiles(req.user.id, id, parseIds(asObject(req.body).ids));
  }

  @Get(':id/shares')
  async shares(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Param('id') id: string): Promise<{ people: PublicPerson[] }> {
    res.setHeader('Cache-Control', 'no-store');
    return { people: await this.albums.shares(req.user.id, id) };
  }

  @Put(':id/shares/:login')
  async share(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Param('id') id: string, @Param('login') login: string): Promise<{ ok: true }> {
    requireJson(req);
    res.setHeader('Cache-Control', 'no-store');
    await this.albums.share(req.user.id, id, login);
    return { ok: true };
  }

  @Delete(':id/shares/:login')
  async unshare(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Param('id') id: string, @Param('login') login: string): Promise<{ ok: true }> {
    res.setHeader('Cache-Control', 'no-store');
    await this.albums.unshare(req.user.id, id, login);
    return { ok: true };
  }

  // Убрать чужой альбом из своего списка.
  @Post(':id/leave')
  @HttpCode(200)
  async leave(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Param('id') id: string): Promise<{ ok: true }> {
    requireJson(req);
    res.setHeader('Cache-Control', 'no-store');
    await this.albums.leave(req.user.id, id);
    return { ok: true };
  }

  // Сохранить файлы общего альбома в свою библиотеку (без выбранных ids — весь альбом).
  @Post(':id/save')
  @HttpCode(200)
  async save(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Param('id') id: string): Promise<{ added: number; skipped: number; quota: boolean }> {
    requireJson(req);
    res.setHeader('Cache-Control', 'no-store');
    const { ownerId } = await this.albums.getVisible(req.user.id, id);
    const ids = asObject(req.body).ids === undefined ? await this.albums.fileIds(req.user.id, id) : parseIds(asObject(req.body).ids);
    if (ownerId === req.user.id) return { added: 0, skipped: ids.length, quota: false };
    return this.files.saveShared(req.user, ids);
  }

  @Post(':id/remove')
  @HttpCode(200)
  async removeFiles(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Param('id') id: string): Promise<{ removed: number }> {
    requireJson(req);
    res.setHeader('Cache-Control', 'no-store');
    return { removed: await this.albums.removeFiles(req.user.id, id, parseIds(asObject(req.body).ids)) };
  }

  @Get(':id/zip')
  async zip(@Req() req: Req_, @Res() res: Response, @Param('id') id: string): Promise<void> {
    const { title, rows } = await this.albums.albumRows(req.user.id, id);
    await sendZip(this.albums, res, title, rows);
  }
}

// Скачивание любой подборки: GET /api/zip?ids=1,2,3&name=Отпуск. Только чтение, поэтому GET.
@Controller('zip')
@UseGuards(SessionGuard)
export class ZipController {
  constructor(private readonly albums: AlbumsService) {}

  @Get()
  async selection(@Req() req: Req_, @Res() res: Response, @Query('ids') ids?: string, @Query('name') name?: string): Promise<void> {
    const list = parseIds(typeof ids === 'string' ? ids.split(',') : []);
    const rows = await this.albums.selectionRows(req.user.id, list);
    await sendZip(this.albums, res, typeof name === 'string' && name ? name : 'DV Cloud', rows);
  }
}
