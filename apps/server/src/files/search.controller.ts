import { BadRequestException, Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { SessionGuard } from '../auth/session.guard';
import { UserRow } from '../users/users.service';
import { PublicFile, toPublicFile } from './files.service';
import { SearchService, SearchStatus } from './search.service';

type Req_ = Request & { user: UserRow };

// Поиск по смыслу по своей библиотеке: «собака на пляже», «скриншот переписки». Только чтение.
@Controller('search')
@UseGuards(SessionGuard)
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get('status')
  async status(@Req() req: Req_, @Res({ passthrough: true }) res: Response): Promise<SearchStatus> {
    res.setHeader('Cache-Control', 'no-store');
    return this.search.status(req.user.id);
  }

  @Get()
  async find(@Req() req: Req_, @Res({ passthrough: true }) res: Response, @Query('q') q?: string, @Query('limit') limit?: string): Promise<{ files: (PublicFile & { score: number })[]; indexed: number; total: number }> {
    res.setHeader('Cache-Control', 'no-store');
    const text = typeof q === 'string' ? q.trim() : '';
    if (text.length < 1 || text.length > 200) throw new BadRequestException('q: запрос от 1 до 200 символов');
    const lim = limit === undefined ? 120 : Number(limit);
    if (!Number.isInteger(lim) || lim < 1 || lim > 300) throw new BadRequestException('limit: от 1 до 300');
    const r = await this.search.search(req.user.id, text, lim);
    return { files: r.hits.map((h) => ({ ...toPublicFile(h.file), score: Math.round(h.score * 1000) / 1000 })), indexed: r.status.indexed, total: r.status.total };
  }
}
