import { Injectable } from '@nestjs/common';
import { DbService } from './db.service';

// Типы событий для аудита
export type AuditActor = 'admin' | 'system' | 'user';

export type AuditAction =
  | 'user.created'
  | 'user.updated'
  | 'user.deleted'
  | 'user.password_changed'
  | 'device.created'
  | 'device.revoked'
  | 'device.inactive_revoked'
  | 'session.created'
  | 'session.revoked'
  | 'backup.started'
  | 'backup.completed'
  | 'backup.failed';

// Журнал действий. Пароли и токены сюда не пишутся.
@Injectable()
export class AuditService {
  constructor(private readonly db: DbService) {}

  // Старый интерфейс: write(action, target, details) — actor='admin'
  async write(action: string, target: string, details?: Record<string, unknown>): Promise<void>;
  // Новый интерфейс: write(actor, action, target, details)
  async write(actor: AuditActor, action: string, target: string, details?: Record<string, unknown>): Promise<void>;
  // Реализация
  async write(
    actorOrAction: string,
    actionOrTarget: string,
    targetOrDetails?: string | Record<string, unknown>,
    details?: Record<string, unknown>,
  ): Promise<void> {
    let actor: string;
    let action: string;
    let target: string;
    let det: Record<string, unknown>;

    if (typeof targetOrDetails === 'string') {
      // Новый вызов: write(actor, action, target, details)
      actor = actorOrAction;
      action = actionOrTarget;
      target = targetOrDetails;
      det = details ?? {};
    } else {
      // Старый вызов: write(action, target, details)
      actor = 'admin';
      action = actorOrAction;
      target = actionOrTarget;
      det = targetOrDetails ?? {};
    }

    await this.db.query('INSERT INTO audit_log (actor, action, target, details) VALUES ($1, $2, $3, $4)', [
      actor,
      action,
      target,
      JSON.stringify(det),
    ]);
  }
}
