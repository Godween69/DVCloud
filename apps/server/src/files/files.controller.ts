import { BadRequestException, Controller, Delete, Get, HttpCode, Param, Post, Query, Req, Res, UnsupportedMediaTypeException, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { SessionGuard } from '../auth/session.guard';
import { asObject, requireJson } from '../http';
import { UserRow } from '../users/users.service';
import { parseIds } from './albums.service';
import { ClaimResult, Estimate, FeedKind, FilesService, MAX_CLAIM, PublicFile, toPublicFile } from './files.service';
import { contentDisposition } from './names';
import { StorageService } from './storage.service';
import { ThumbsService } from './thumbs.service';
import { VideoService } from './video.service';

type Req_ = Request & { user: UserRow };

// Файлы человека. Владелец берётся только из сессии, id файла проверяется на принадлежность в каждом запросе.
@Controller('files')
@UseGuards(SessionGuard)
export class FilesController {
  constructor(
    private readonly files: FilesService,
    private readonly storage: StorageService,
    private readonly thumbs: ThumbsService,
    private readonly video: VideoService,
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
  async list(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Query('trashed') trashed?: string, @Query('limit') limit?: string, @Query('before') before?: string, @Query('kind') kind?: string, @Query('at') at?: string, @Query('tz') tz?: string, @Query('after') after?: string, @Query('person') person?: string): Promise<{ files: PublicFile[]; next: string | null; prev: string | null }> {
    if (kind !== undefined && kind !== 'photos' && kind !== 'videos' && kind !== 'screenshots' && kind !== 'library') throw new BadRequestException('kind: library, photos, videos или screenshots');
    const lim = limit === undefined ? 100 : Number(limit);
    if (!Number.isInteger(lim) || lim < 1 || lim > 500) throw new BadRequestException('limit: от 1 до 500');
    const r = await this.files.list(req.user.id, { trashed: trashed === '1', limit: lim, before: typeof before === 'string' ? before : undefined, kind: kind as FeedKind | undefined, at: typeof at === 'string' ? at : undefined, tz: typeof tz === 'string' ? tz : undefined, after: typeof after === 'string' ? after : undefined, person: typeof person === 'string' ? person : undefined });
    res.setHeader('Cache-Control', 'no-store');
    return { files: r.files.map(toPublicFile), next: r.next, prev: r.prev };
  }

  // Оглавление по месяцам для полосы времени (до маршрутов с :id).
  @Get('timeline')
  async timeline(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Query('kind') kind?: string, @Query('tz') tz?: string, @Query('person') person?: string): Promise<{ months: { y: number; m: number; n: number }[] }> {
    if (kind !== undefined && kind !== 'photos' && kind !== 'videos' && kind !== 'screenshots' && kind !== 'library') throw new BadRequestException('kind: library, photos, videos или screenshots');
    res.setHeader('Cache-Control', 'no-store');
    return { months: await this.files.timeline(req.user.id, kind as FeedKind | undefined, typeof tz === 'string' ? tz : 'UTC', { person: typeof person === 'string' ? person : undefined }) };
  }

  @Get('usage')
  async usage(@Req() req: Req_, @Res({ passthrough: true }) res: Response): Promise<{ usedBytes: number; quotaBytes: number | null; count: number }> {
    res.setHeader('Cache-Control', 'no-store');
    const u = await this.files.usage(req.user.id);
    return { ...u, quotaBytes: req.user.quota_bytes === null ? null : Number(req.user.quota_bytes) };
  }

  // Заявка по хешу: «такой файл уже есть в облаке?». Если есть, запись создаётся сразу и загружать нечего.
  @Post('claim')
  @HttpCode(200)
  async claim(@Req() req: Req_, @Res({ passthrough: true }) res: Response): Promise<{ results: ClaimResult[] }> {
    requireJson(req);
    res.setHeader('Cache-Control', 'no-store');
    const items = asObject(req.body).items;
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_CLAIM) throw new BadRequestException(`items: список от 1 до ${MAX_CLAIM} файлов`);
    return { results: await this.files.claim(req.user, items.map((x) => asObject(x))) };
  }

  // Оценка перед загрузкой папки: сколько байт нужно и влезет ли в остаток квоты.
  @Post('estimate')
  @HttpCode(200)
  async estimate(@Req() req: Req_, @Res({ passthrough: true }) res: Response): Promise<Estimate> {
    requireJson(req);
    res.setHeader('Cache-Control', 'no-store');
    const n = asObject(req.body).bytes;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new BadRequestException('Поле bytes: число байт');
    return this.files.estimate(req.user, n);
  }

  // Просьба к администратору добавить место.
  @Post('quota-request')
  @HttpCode(200)
  async quotaRequest(@Req() req: Req_, @Res({ passthrough: true }) res: Response): Promise<{ ok: true }> {
    requireJson(req);
    res.setHeader('Cache-Control', 'no-store');
    const o = asObject(req.body);
    if (typeof o.needBytes !== 'number' || !Number.isSafeInteger(o.needBytes) || o.needBytes < 1) throw new BadRequestException('Поле needBytes: число байт');
    await this.files.requestQuota(req.user, o.needBytes, typeof o.note === 'string' ? o.note : '');
    return { ok: true };
  }

  // Действие над многими файлами: hide (в корзину), restore (вернуть), remove (убрать из корзины насовсем у себя).
  @Post('bulk')
  @HttpCode(200)
  async bulk(@Req() req: Req_, @Res({ passthrough: true }) res: Response): Promise<{ changed: number }> {
    requireJson(req);
    res.setHeader('Cache-Control', 'no-store');
    const o = asObject(req.body);
    if (o.action !== 'hide' && o.action !== 'restore' && o.action !== 'remove') throw new BadRequestException('action: hide, restore или remove');
    return { changed: await this.files.bulk(req.user, o.action, parseIds(o.ids)) };
  }

  // Ручная смена вида картинки: {kind: 'screenshot' | 'photo' | 'auto', ids}. Видео пропускаются.
  @Post('kind')
  @HttpCode(200)
  async kind(@Req() req: Req_, @Res({ passthrough: true }) res: Response): Promise<{ changed: number }> {
    requireJson(req);
    res.setHeader('Cache-Control', 'no-store');
    const o = asObject(req.body);
    if (o.kind !== 'screenshot' && o.kind !== 'photo' && o.kind !== 'auto') throw new BadRequestException('kind: screenshot, photo или auto');
    return { changed: await this.files.setKind(req.user, o.kind, parseIds(o.ids)) };
  }

  // Очистить корзину: записи человека исчезают, файлы на диске остаются до решения администратора.
  @Delete('trash')
  async emptyTrash(@Req() req: Req_, @Res({ passthrough: true }) res: Response): Promise<{ removed: number }> {
    res.setHeader('Cache-Control', 'no-store');
    return { removed: await this.files.emptyTrash(req.user) };
  }

  // Миниатюра фото (маленький WebP). id неизменен и содержимое тоже, поэтому браузер может хранить её год.
  // Если миниатюру сделать нельзя (битый файл), отвечаем 404, и сайт показывает значок.
  @Get(':id/thumb')
  async thumb(@Req() req: Req_, @Res() res: Response, @Param('id') id: string, @Query('fit') fit?: string): Promise<void> {
    const f = await this.files.getReadable(req.user.id, id);
    // fit=1: миниатюра целиком в пропорциях снимка (для «Умной плитки»), иначе квадрат
    const rel = fit === '1' ? await this.thumbs.ensureFit(f) : await this.thumbs.ensure(f); // скрытые файлы тоже: они остаются на месте
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

  // Превью для просмотра (WebP до 2000 px). Если сделать нельзя (видео, битый файл), 404, и сайт открывает оригинал.
  @Get(':id/preview')
  async preview(@Req() req: Req_, @Res() res: Response, @Param('id') id: string): Promise<void> {
    const f = await this.files.getReadable(req.user.id, id);
    const rel = await this.thumbs.ensurePreview(f); // в корзине файл виден только владельцу (getReadable), ему превью можно: посмотреть, что за снимок
    if (!rel) {
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.status(404).json({ message: 'Превью нет' });
      return;
    }
    res.setHeader('Content-Type', 'image/webp');
    res.sendFile(rel, {
      root: this.storage.root,
      dotfiles: 'deny',
      headers: { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, max-age=3600' }, // настройки превью можно менять: час, не год
    }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ message: 'Превью нет' });
    });
  }

  // Видео для просмотра: уменьшенная копия (H.264), если она готова и включена в админке. Иначе 404, и сайт играет оригинал.
  @Get(':id/view')
  async view(@Req() req: Req_, @Res() res: Response, @Param('id') id: string): Promise<void> {
    const f = await this.files.getReadable(req.user.id, id);
    const rel = f.trashed_at ? null : await this.video.copyFor(f);
    if (!rel) {
      if (!f.trashed_at && f.mime.startsWith('video/')) this.video.want(f.blob_id); // открыли без копии: сделать её вне очереди
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(404).json({ message: 'Копии для просмотра нет' });
      return;
    }
    res.setHeader('Content-Type', 'video/mp4');
    res.sendFile(rel, {
      root: this.storage.root,
      dotfiles: 'deny',
      headers: { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, no-cache' },
    }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ message: 'Копии для просмотра нет' });
    });
  }

  // Окно «Инфо»: метаданные файла и следы даты съёмки.
  @Get(':id/info')
  async info(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Param('id') id: string): ReturnType<FilesService['info']> {
    res.setHeader('Cache-Control', 'no-store');
    return this.files.info(req.user.id, id);
  }

  // Отдача оригинала. sendFile сам умеет Range (докачка и перемотка видео) и не выходит за каталог данных.
  @Get(':id')
  async download(@Req() req: Req_, @Res() res: Response, @Param('id') id: string, @Query('download') dl?: string): Promise<void> {
    const f = await this.files.getReadable(req.user.id, id);
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
