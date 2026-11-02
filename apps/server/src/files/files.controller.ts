import { BadRequestException, Controller, Delete, Get, HttpCode, Param, Post, Query, Req, Res, UnsupportedMediaTypeException, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { SessionGuard } from '../auth/session.guard';
import { requireJson } from '../http';
import { UserRow } from '../users/users.service';
import { FilesService, PublicFile, toPublicFile } from './files.service';
import { contentDisposition } from './names';
import { StorageService } from './storage.service';
import { ThumbsService } from './thumbs.service';

type Req_ = Request & { user: UserRow };

// Файлы человека. Владелец берётся только из сессии, id файла проверяется на принадлежность в каждом запросе.
@Controller('files')
@UseGuards(SessionGuard)
export class FilesController {
  constructor(
    private readonly files: FilesService,
    private readonly storage: StorageService,
    private readonly thumbs: ThumbsService,
  ) {}

  // Загрузка одного файла потоком: тело запроса это сам файл. Имя в ?name=, дата снимка в заголовке X-File-Modified.
  // Content-Type обязан быть application/octet-stream: форма с чужого сайта так отправить не может (это защита от CSRF).
  @Post()
  async upload(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Query('name') name?: string): Promise<{ file: PublicFile; duplicate: boolean } | undefined> {
    if (!req.is('application/octet-stream')) throw new UnsupportedMediaTypeException('Нужен Content-Type: application/octet-stream');
    if (typeof name !== 'string' || name.length < 1 || name.length > 400) throw new BadRequestException('Параметр name: имя файла');
    const cl = req.headers['content-length'];
    const modified = req.headers['x-file-modified'];
    try {
      const { file, duplicate } = await this.files.upload(req.user, req, {
        name,
        contentLength: cl !== undefined && /^\d+$/.test(cl) ? Number(cl) : undefined,
        modified: typeof modified === 'string' ? modified : undefined,
      });
      res.status(duplicate ? 200 : 201);
      res.setHeader('Cache-Control', 'no-store');
      return { file: toPublicFile(file), duplicate };
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ECONNRESET') return undefined; // клиент оборвал загрузку, отвечать некому
      res.setHeader('Connection', 'close');
      throw e;
    }
  }

  @Get()
  async list(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Query('trashed') trashed?: string, @Query('limit') limit?: string, @Query('before') before?: string): Promise<{ files: PublicFile[]; next: string | null }> {
    const lim = limit === undefined ? 100 : Number(limit);
    if (!Number.isInteger(lim) || lim < 1 || lim > 500) throw new BadRequestException('limit: от 1 до 500');
    const r = await this.files.list(req.user.id, { trashed: trashed === '1', limit: lim, before: typeof before === 'string' ? before : undefined });
    res.setHeader('Cache-Control', 'no-store');
    return { files: r.files.map(toPublicFile), next: r.next };
  }

  @Get('usage')
  async usage(@Req() req: Req_, @Res({ passthrough: true }) res: Response): Promise<{ usedBytes: number; quotaBytes: number | null; count: number }> {
    res.setHeader('Cache-Control', 'no-store');
    const u = await this.files.usage(req.user.id);
    return { ...u, quotaBytes: req.user.quota_bytes === null ? null : Number(req.user.quota_bytes) };
  }

  // Миниатюра фото (маленький WebP). id неизменен и содержимое тоже, поэтому браузер может хранить её год.
  // Если миниатюру сделать нельзя (видео, HEIC, битый файл), отвечаем 404, и сайт показывает значок.
  @Get(':id/thumb')
  async thumb(@Req() req: Req_, @Res() res: Response, @Param('id') id: string): Promise<void> {
    const f = await this.files.getOwned(req.user.id, id);
    const rel = f.trashed_at ? null : await this.thumbs.ensure(f);
    if (!rel) {
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.status(404).json({ message: 'Миниатюры нет' });
      return;
    }
    res.setHeader('Content-Type', 'image/webp');
    res.sendFile(rel, {
      root: this.storage.root,
      dotfiles: 'deny',
      headers: {
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ message: 'Миниатюры нет' });
    });
  }

  // Отдача оригинала. sendFile сам умеет Range (докачка и перемотка видео) и не выходит за каталог данных.
  @Get(':id')
  async download(@Req() req: Req_, @Res() res: Response, @Param('id') id: string, @Query('download') dl?: string): Promise<void> {
    const f = await this.files.getOwned(req.user.id, id);
    if (f.trashed_at) {
      res.status(404).json({ message: 'Файл не найден' });
      return;
    }
    res.setHeader('Content-Type', f.mime);
    res.sendFile(f.path, {
      root: this.storage.root,
      dotfiles: 'deny',
      headers: {
        'Content-Disposition': contentDisposition(f.original_name, dl === '1'),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'private, no-cache',
      },
    }, (err) => {
      if (!err || res.headersSent) return;
      const code = (err as NodeJS.ErrnoException).code;
      res.status(code === 'ENOENT' ? 404 : 500).json({ message: code === 'ENOENT' ? 'Файл на диске не найден' : 'Не удалось отдать файл' });
    });
  }

  // В корзину; с ?permanent=1 окончательно, но только из корзины.
  @Delete(':id')
  async remove(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Param('id') id: string, @Query('permanent') permanent?: string): Promise<{ ok: true } | { file: PublicFile }> {
    res.setHeader('Cache-Control', 'no-store');
    if (permanent === '1') {
      await this.files.deletePermanently(req.user, id);
      return { ok: true };
    }
    return { file: toPublicFile(await this.files.trash(req.user, id)) };
  }

  @Post(':id/restore')
  @HttpCode(200)
  async restore(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Param('id') id: string): Promise<{ file: PublicFile }> {
    requireJson(req);
    res.setHeader('Cache-Control', 'no-store');
    return { file: toPublicFile(await this.files.restore(req.user, id)) };
  }
}
