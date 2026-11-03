import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { SessionGuard } from '../auth/session.guard';
import { UserRow } from '../users/users.service';
import { FingerprintService } from './fingerprint.service';
import { SimilarGroup, SimilarService } from './similar.service';

type Req_ = Request & { user: UserRow };

// Похожие фото человека: только чтение. Само удаление идёт обычным DELETE /api/files/:id (в корзину).
@Controller('similar')
@UseGuards(SessionGuard)
export class SimilarController {
  constructor(
    private readonly similar: SimilarService,
    private readonly fp: FingerprintService,
  ) {}

  @Get('duplicates')
  async duplicates(@Req() req: Req_, @Res({ passthrough: true }) res: Response): Promise<{ groups: SimilarGroup[]; images: number; ready: number }> {
    res.setHeader('Cache-Control', 'no-store');
    const [groups, p] = await Promise.all([this.similar.duplicates(req.user.id), this.fp.progress(req.user.id)]);
    return { groups, ...p };
  }

  @Get('series')
  async series(@Req() req: Req_, @Res({ passthrough: true }) res: Response): Promise<{ groups: SimilarGroup[]; images: number; ready: number }> {
    res.setHeader('Cache-Control', 'no-store');
    const [groups, p] = await Promise.all([this.similar.series(req.user.id), this.fp.progress(req.user.id)]);
    return { groups, ...p };
  }
}
