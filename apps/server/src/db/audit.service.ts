import { Injectable } from '@nestjs/common';
import { DbService } from './db.service';

// Журнал действий администратора. Пароли и токены сюда не пишутся.
@Injectable()
export class AuditService {
  constructor(private readonly db: DbService) {}

  async write(action: string, target: string, details: Record<string, unknown> = {}): Promise<void> {
    await this.db.query('INSERT INTO audit_log (actor, action, target, details) VALUES ($1, $2, $3, $4)', [
      'admin',
      action,
      target,
      JSON.stringify(details),
    ]);
  }
}
