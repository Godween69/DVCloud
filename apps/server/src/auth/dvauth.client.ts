import { HttpException, Inject, Injectable } from '@nestjs/common';
import { Config } from '../config';
import { CONFIG } from '../tokens';

export interface FactorStatus {
  enabled: boolean;
  chatAvailable: boolean;
  chatLinked: boolean;
  matrixId: string | null;
  totpAvailable: boolean;
  totpEnabled: boolean;
  recoveryLeft: number;
  methods: string[];
}

export interface ChatChallenge {
  challenge: string;
  number: string;
  qr: string;
  expiresIn: number;
}

const DOWN = 'Сервис второго фактора сейчас недоступен. Попробуйте позже.';

// Клиент DV Auth (отдельный сервис второго фактора). Если он настроен, но не отвечает, вход закрыт:
// «не знаю, включён ли второй фактор» нельзя считать «не включён».
@Injectable()
export class DvAuthClient {
  constructor(@Inject(CONFIG) private readonly cfg: Config) {}

  get enabled(): boolean {
    return this.cfg.authUrl !== '';
  }

  async call<T>(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.cfg.authUrl + path, {
        method,
        headers: { authorization: `Bearer ${this.cfg.authSecret}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new HttpException(DOWN, 503);
    }
    let json: { error?: string; message?: string } & Record<string, unknown> = {};
    try {
      json = (await res.json()) as typeof json;
    } catch {
      /* не JSON */
    }
    if (res.ok) return json as T;
    // Неверный секрет приложения и внутренние ошибки наружу как «неверный код» не показываем.
    if (res.status >= 500 || json.error === 'unauthorized') throw new HttpException(DOWN, 503);
    throw new HttpException(json.message ?? 'Ошибка второго фактора', res.status);
  }

  status(subject: string): Promise<FactorStatus> {
    return this.call('GET', `/v1/status?subject=${encodeURIComponent(subject)}`);
  }
}
