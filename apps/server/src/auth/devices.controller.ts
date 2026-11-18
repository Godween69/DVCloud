import { Controller, Delete, Get, Param, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { UserRow } from '../users/users.service';
import { DeviceTokensService } from './device-tokens.service';
import { SessionGuard } from './session.guard';

@Controller('auth/devices')
@UseGuards(SessionGuard)
export class DevicesController {
  constructor(private readonly deviceTokens: DeviceTokensService) {}

  @Get()
  async list(@Req() req: Request & { user: UserRow }, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.deviceTokens.listForUser(req.user.id);
  }

  @Delete(':id')
  async revoke(
    @Param('id') id: string,
    @Req() req: Request & { user: UserRow; authKind?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    await this.deviceTokens.revoke(id, req.user.id);
    return { ok: true };
  }
}
