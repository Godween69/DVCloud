import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DeviceTokensService } from './device-tokens.service';
import { Config } from '../config';
import { CONFIG } from '../tokens';
import { Inject } from '@nestjs/common';

// Cron-задача для отзыва неактивных устройств
@Injectable()
export class DeviceCleanupService {
  private readonly logger = new Logger(DeviceCleanupService.name);

  constructor(
    private readonly deviceTokens: DeviceTokensService,
    @Inject(CONFIG) private readonly cfg: Config,
  ) {}

  // Каждый день в 03:00 (после ночных бэкапов)
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async handleInactiveDevices(): Promise<void> {
    try {
      const months = this.cfg.deviceInactiveMonths;
      this.logger.log(`Проверка неактивных устройств (порог: ${months} мес.)...`);

      const count = await this.deviceTokens.revokeInactive(months);

      if (count > 0) {
        this.logger.log(`Отозвано ${count} устройств`);
      } else {
        this.logger.log('Неактивных устройств не найдено');
      }
    } catch (error) {
      this.logger.error('Ошибка при отзыве неактивных устройств', error);
    }
  }
}
