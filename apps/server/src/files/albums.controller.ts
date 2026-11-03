import { BadRequestException, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { pipeline } from 'node:stream';
import { Readable } from 'node:stream';
import { SessionGuard } from '../auth/session.guard';
import { asObject, requireJson } from '../http';
import { UserRow } from '../users/users.service';
import { AlbumsService, parseIds, PublicAlbum, zipFileName } from './albums.service';
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
    return { album: await this.albums.create(req.user.id, asObject(req.body).name) };
  }

  // В каком альбоме лежит файл (null = ни в каком). Путь из двух частей, поэтому не пересекается с ':id/...'.
  @Get('of-file/:fileId')
  async ofFile(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Param('fileId') fileId: string): Promise<{ album: { id: string; name: string } | null }> {
    res.setHeader('Cache-Control', 'no-store');
    return { album: await this.albums.albumOfFile(req.user.id, fileId) };
  }

  @Patch(':id')
  async rename(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Param('id') id: string): Promise<{ album: PublicAlbum }> {
    requireJson(req);
    res.setHeader('Cache-Control', 'no-store');
    return { album: await this.albums.rename(req.user.id, id, asObject(req.body).name) };
  }

  @Delete(':id')
  async remove(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Param('id') id: string): Promise<{ ok: true }> {
    res.setHeader('Cache-Control', 'no-store');
    await this.albums.remove(req.user.id, id);
    return { ok: true };
  }

  @Get(':id/files')
  async feed(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Param('id') id: string, @Query('limit') limit?: string, @Query('before') before?: string): Promise<{ album: PublicAlbum; files: PublicFile[]; next: string | null }> {
    const lim = limit === undefined ? 100 : Number(limit);
    if (!Number.isInteger(lim) || lim < 1 || lim > 500) throw new BadRequestException('limit: от 1 до 500');
    const album = await this.albums.get(req.user.id, id);
    const r = await this.files.list(req.user.id, { trashed: false, limit: lim, before: typeof before === 'string' ? before : undefined, albumId: album.id });
    res.setHeader('Cache-Control', 'no-store');
    return { album, files: r.files.map(toPublicFile), next: r.next };
  }

  @Get(':id/ids')
  async ids(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Param('id') id: string): Promise<{ ids: string[] }> {
    res.setHeader('Cache-Control', 'no-store');
    return { ids: await this.albums.fileIds(req.user.id, id) };
  }

  @Post(':id/add')
  @HttpCode(200)
  async add(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Param('id') id: string): Promise<{ added: number }> {
    requireJson(req);
    res.setHeader('Cache-Control', 'no-store');
    return { added: await this.albums.addFiles(req.user.id, id, parseIds(asObject(req.body).ids)) };
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
