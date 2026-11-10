import { Inject, Injectable } from '@nestjs/common';
import { Config } from '../config';
import { CONFIG } from '../tokens';

export interface LoginCookie {
  name: string;
  value: string;
  domain: string;
}
export type LoginStatus =
  | { state: 'waiting' }
  | { state: 'done'; cookies: LoginCookie[] }
  | { state: 'failed'; note: string }
  | { state: 'unknown' };

// Связь с помощником входа: отдельный контейнер с браузером, который открывает страницу входа Яндекса, показывает QR
// и после подтверждения на телефоне отдаёт куки. Помощник наружу не виден, говорит только с сервером по общему секрету.
@Injectable()
export class LoginClient {
  constructor(@Inject(CONFIG) private readonly cfg: Config) {}

  get configured(): boolean {
    return this.cfg.yandexLoginUrl !== '' && this.cfg.secretsKey !== '';
  }

  private async call(method: string, path: string): Promise<Response> {
    try {
      return await fetch(this.cfg.yandexLoginUrl + path, { method, headers: { authorization: `Bearer ${this.cfg.yandexLoginToken}` }, signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new Error('Помощник входа недоступен');
    }
  }

  async start(): Promise<string> {
    const r = await this.call('POST', '/login');
    if (!r.ok) throw new Error(`Помощник входа не стартовал (HTTP ${r.status})`);
    const j = (await r.json()) as { id?: string };
    if (typeof j.id !== 'string' || !/^[0-9a-f]{16,64}$/.test(j.id)) throw new Error('Помощник входа ответил неверно');
    return j.id;
  }

  // Картинка с QR; null, пока помощник её не получил.
  async qr(id: string): Promise<Buffer | null> {
    const r = await this.call('GET', `/login/${id}/qr`);
    if (r.status === 404 || r.status === 204) return null;
    if (!r.ok) throw new Error(`Помощник входа: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }

  async status(id: string): Promise<LoginStatus> {
    const r = await this.call('GET', `/login/${id}`);
    if (r.status === 404) return { state: 'unknown' };
    if (!r.ok) throw new Error(`Помощник входа: HTTP ${r.status}`);
    return (await r.json()) as LoginStatus;
  }

  // Помощник стирает у себя всё, что связано со входом (куки, снимки).
  async finish(id: string): Promise<void> {
    try {
      await this.call('DELETE', `/login/${id}`);
    } catch {
      /* помощник сам чистит брошенные входы по таймеру */
    }
  }
}
