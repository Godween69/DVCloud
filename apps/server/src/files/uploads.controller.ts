import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, Res, UnsupportedMediaTypeException, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { SessionGuard } from '../auth/session.guard';
import { asObject, requireJson } from '../http';
import { UserRow } from '../users/users.service';
import { PublicFile, toPublicFile } from './files.service';
import { parseOffset, UploadsService, UploadState } from './uploads.service';

type Req_ = Request & { user: UserRow };

// Загрузка по частям с докачкой (см. docs/FILES.md): POST создаёт, GET спрашивает «сколько принято», PATCH дописывает кусок.
@Controller('uploads')
@UseGuards(SessionGuard)
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post()
  @HttpCode(200)
  async start(@Req() req: Req_, @Res({ passthrough: true }) res: Response): Promise<UploadState> {
    requireJson(req);
    res.setHeader('Cache-Control', 'no-store');
    const o = asObject(req.body);
    return this.uploads.start(req.user, { name: o.name, size: o.size, modified: o.modified });
  }

  @Get(':id')
  async status(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Param('id') id: string): Promise<UploadState> {
    res.setHeader('Cache-Control', 'no-store');
    return this.uploads.status(req.user, id);
  }

  // Тело запроса это сам кусок. Content-Type application/octet-stream и заголовок Upload-Offset защищают от отправки из чужой формы.
  @Patch(':id')
  @HttpCode(200)
  async chunk(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Param('id') id: string): Promise<{ offset: number; size: number; done: boolean; file?: PublicFile; duplicate?: boolean } | undefined> {
    if (!req.is('application/octet-stream')) throw new UnsupportedMediaTypeException('Нужен Content-Type: application/octet-stream');
    const offset = parseOffset(req.headers['upload-offset']);
    res.setHeader('Cache-Control', 'no-store');
    try {
      const r = await this.uploads.append(req.user, id, offset, req);
      return { offset: r.state.offset, size: r.state.size, done: r.file !== undefined, file: r.file ? toPublicFile(r.file) : undefined, duplicate: r.duplicate };
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ECONNRESET') return undefined; // клиент оборвал, он спросит GET
      res.setHeader('Connection', 'close');
      throw e;
    }
  }

  @Delete(':id')
  async cancel(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Param('id') id: string): Promise<{ ok: true }> {
    res.setHeader('Cache-Control', 'no-store');
    await this.uploads.cancel(req.user, id);
    return { ok: true };
  }
}
