import { Inject, Injectable } from '@nestjs/common';
import { Config } from '../config';
import { CONFIG } from '../tokens';

export interface MlHealth {
  model: string;
  ready: boolean; // файлы модели на месте
}

export interface MlVector {
  model: string;
  vector: Buffer; // float32 little-endian, нормирован
}

// Ошибка ML-сервиса. status 0 = сервис недоступен (сеть, таймаут); 4xx = запрос плохой (например, картинка не читается);
// 5xx = у сервиса беда (нет файлов модели, сбой).
export class MlError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
  get unavailable(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

const MIN_BYTES = 16;

// Клиент ML-сервиса (apps/ml). Сервис живёт в закрытой сети Docker, без интернета; адрес берётся из DVCLOUD_ML_URL.
@Injectable()
export class MlClient {
  private readonly url: string;

  constructor(@Inject(CONFIG) cfg: Config) {
    this.url = cfg.mlUrl;
  }

  get configured(): boolean {
    return this.url !== '';
  }

  // null: сервис не отвечает. Холодный старт модели долгий, но /health её не грузит, поэтому ждём недолго.
  async health(): Promise<MlHealth | null> {
    if (!this.configured) return null;
    try {
      const r = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) return null;
      const j = (await r.json()) as { model?: unknown; ready?: unknown };
      if (typeof j.model !== 'string') return null;
      return { model: j.model, ready: j.ready === true };
    } catch {
      return null;
    }
  }

  // Холодная загрузка половины модели занимает секунды (текстовая половина тяжёлая), поэтому таймаут большой.
  private async post(path: string, body: Buffer | string, type: string): Promise<MlVector> {
    if (!this.configured) throw new MlError(0, 'Служба поиска не настроена');
    let r: Response;
    try {
      r = await fetch(`${this.url}${path}`, { method: 'POST', headers: { 'content-type': type }, body, signal: AbortSignal.timeout(120_000) });
    } catch {
      throw new MlError(0, 'Служба поиска недоступна');
    }
    let j: { error?: unknown; model?: unknown; vector?: unknown } = {};
    try {
      j = (await r.json()) as typeof j;
    } catch {
      /* не JSON */
    }
    if (!r.ok) throw new MlError(r.status, typeof j.error === 'string' ? j.error : `Служба поиска ответила ${r.status}`);
    if (typeof j.model !== 'string' || typeof j.vector !== 'string') throw new MlError(502, 'Служба поиска вернула непонятный ответ');
    const vector = Buffer.from(j.vector, 'base64');
    if (vector.length < MIN_BYTES || vector.length % 4 !== 0) throw new MlError(502, 'Служба поиска вернула вектор неверной длины');
    return { model: j.model, vector };
  }

  image(data: Buffer): Promise<MlVector> {
    return this.post('/embed/image', data, 'application/octet-stream');
  }

  text(text: string): Promise<MlVector> {
    return this.post('/embed/text', JSON.stringify({ text }), 'application/json');
  }
}
