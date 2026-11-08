import { Inject, Injectable } from '@nestjs/common';
import { Config } from '../config';
import { CONFIG } from '../tokens';

export interface MlHealth {
  model: string;
  ready: boolean; // файлы модели на месте
  faces: { ready: boolean; model: string } | null; // модель лиц (null: служба старой версии, лиц не знает)
  pets: { ready: boolean; model: string } | null;
}

// Находка на картинке: рамка в долях картинки (0..1), оценка, вектор (float32 little-endian, нормирован).
export interface MlDetection {
  kind: 'face' | 'cat' | 'dog';
  box: [number, number, number, number]; // x, y, ширина, высота
  score: number;
  vector: Buffer;
}
export interface MlDetections {
  model: string;
  detections: MlDetection[];
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
      const j = (await r.json()) as { model?: unknown; ready?: unknown; faces?: unknown; pets?: unknown };
      if (typeof j.model !== 'string') return null;
      const part = (v: unknown): { ready: boolean; model: string } | null => {
        if (typeof v !== 'object' || v === null) return null;
        const o = v as { ready?: unknown; model?: unknown };
        return typeof o.model === 'string' ? { ready: o.ready === true, model: o.model } : null;
      };
      return { model: j.model, ready: j.ready === true, faces: part(j.faces), pets: part(j.pets) };
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

  // Лица или питомцы на картинке (JPEG, уже уменьшенная). Модели тяжёлые на холодном старте, поэтому таймаут большой.
  private async detect(path: '/faces' | '/pets', field: 'faces' | 'pets', data: Buffer): Promise<MlDetections> {
    if (!this.configured) throw new MlError(0, 'Служба распознавания не настроена');
    let r: Response;
    try {
      r = await fetch(`${this.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: data, signal: AbortSignal.timeout(120_000) });
    } catch {
      throw new MlError(0, 'Служба распознавания недоступна');
    }
    let j: { error?: unknown; model?: unknown; faces?: unknown; pets?: unknown } = {};
    try {
      j = (await r.json()) as typeof j;
    } catch {
      /* не JSON */
    }
    if (!r.ok) throw new MlError(r.status, typeof j.error === 'string' ? j.error : `Служба распознавания ответила ${r.status}`);
    const list = j[field];
    if (typeof j.model !== 'string' || !Array.isArray(list)) throw new MlError(502, 'Служба распознавания вернула непонятный ответ');
    const out: MlDetection[] = [];
    for (const it of list as { kind?: unknown; box?: unknown; score?: unknown; vector?: unknown }[]) {
      const box = it.box;
      if (!Array.isArray(box) || box.length !== 4 || box.some((n) => typeof n !== 'number' || !Number.isFinite(n))) throw new MlError(502, 'Служба распознавания вернула неверную рамку');
      if (typeof it.vector !== 'string' || typeof it.score !== 'number') throw new MlError(502, 'Служба распознавания вернула непонятный ответ');
      const kind = field === 'faces' ? 'face' : it.kind === 'dog' ? 'dog' : it.kind === 'cat' ? 'cat' : null;
      if (!kind) throw new MlError(502, 'Служба распознавания вернула неизвестный вид');
      const vector = Buffer.from(it.vector, 'base64');
      if (vector.length < MIN_BYTES || vector.length % 4 !== 0) throw new MlError(502, 'Служба распознавания вернула вектор неверной длины');
      out.push({ kind, box: box as [number, number, number, number], score: it.score, vector });
    }
    return { model: j.model, detections: out };
  }

  faces(data: Buffer): Promise<MlDetections> {
    return this.detect('/faces', 'faces', data);
  }

  pets(data: Buffer): Promise<MlDetections> {
    return this.detect('/pets', 'pets', data);
  }

  image(data: Buffer): Promise<MlVector> {
    return this.post('/embed/image', data, 'application/octet-stream');
  }

  text(text: string): Promise<MlVector> {
    return this.post('/embed/text', JSON.stringify({ text }), 'application/json');
  }
}
