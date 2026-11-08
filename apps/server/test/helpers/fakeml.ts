// Поддельная ML-служба для тестов: тот же протокол, что у apps/ml, но «смысл» это цвет.
// Картинка -> вектор из среднего цвета, слово «красный/зелёный/синий» -> вектор этого цвета. Поэтому поиск «красный»
// находит красные картинки, и всю цепочку (очередь, база, поиск, порог) можно проверить без настоящей модели.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';

const WORDS: Record<string, [number, number, number]> = { красный: [1, 0, 0], зелёный: [0, 1, 0], синий: [0, 0, 1], red: [1, 0, 0] };

function pack(v: number[]): string {
  const n = Math.hypot(...v);
  const f = new Float32Array(v.map((x) => x / n));
  return Buffer.from(f.buffer).toString('base64');
}

export class FakeMl {
  model = 'fake-color-v1';
  ready = true;
  images = 0;
  texts = 0;
  faceCalls = 0;
  petCalls = 0;
  facesReady = true;
  petsReady = true;
  facesModel = 'fake-faces-v1';
  petsModel = 'fake-pets-v1';
  private srv: Server | null = null;
  url = '';

  async start(port = 0): Promise<void> {
    this.srv = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => void this.handle(req.method ?? '', req.url ?? '', Buffer.concat(chunks), res));
    });
    await new Promise<void>((r) => this.srv!.listen(port, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.srv.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.srv ? this.srv.close(() => r()) : r()));
    this.srv = null;
  }

  private send(res: import('node:http').ServerResponse, code: number, body: unknown): void {
    const s = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
    res.end(s);
  }

  private async handle(method: string, url: string, body: Buffer, res: import('node:http').ServerResponse): Promise<void> {
    if (method === 'GET' && url === '/health') {
      return this.send(res, 200, {
        ok: true, model: this.model, ready: this.ready, loaded: null, dim: 4,
        faces: { ready: this.facesReady, model: this.facesModel }, pets: { ready: this.petsReady, model: this.petsModel },
      });
    }
    // Лица и питомцы по цвету картинки. Красная: лицо А, синяя: лицо Б, зелёная: оба лица, жёлтая: кошка. Оттенок чуть сдвигает вектор,
    // как это бывает у настоящих снимков одного человека. Остальные картинки без находок.
    if (method === 'POST' && (url === '/faces' || url === '/pets')) {
      let r = 0, g = 0, b = 0;
      try {
        const st = await sharp(body).stats();
        [r, g, b] = st.channels.map((c) => c.mean);
      } catch {
        return this.send(res, 400, { error: 'картинка не читается: Error' });
      }
      const vec = (hot: number, wobble: number): string => {
        const v = new Array(8).fill(0);
        v[hot] = 1;
        v[(hot + 3) % 8] = wobble;
        return pack(v);
      };
      const w = (r % 7) / 100;
      if (url === '/faces') {
        this.faceCalls++;
        const out: unknown[] = [];
        const A = r > 150 && g < 100 && b < 100, B = b > 150 && r < 100 && g < 100, AB = g > 150 && r < 100 && b < 100;
        if (A || AB) out.push({ box: [0.1, 0.1, 0.3, 0.4], score: 0.95, vector: vec(0, w) });
        if (B || AB) out.push({ box: [0.55, 0.2, 0.25, 0.3], score: 0.9, vector: vec(1, w) });
        return this.send(res, 200, { model: this.facesModel, dim: 8, faces: out });
      }
      this.petCalls++;
      const cat = r > 150 && g > 150 && b < 100;
      return this.send(res, 200, { model: this.petsModel, clip: this.model, pets: cat ? [{ kind: 'cat', box: [0.2, 0.2, 0.5, 0.5], score: 0.9, vector: vec(2, w) }] : [] });
    }
    if (method === 'POST' && url === '/embed/image') {
      this.images++;
      try {
        const st = await sharp(body).stats();
        const [r, g, b] = st.channels.map((c) => c.mean / 255);
        return this.send(res, 200, { model: this.model, dim: 4, vector: pack([r, g, b, 0.05]) });
      } catch {
        return this.send(res, 400, { error: 'картинка не читается: Error' });
      }
    }
    if (method === 'POST' && url === '/embed/text') {
      this.texts++;
      const t = String((JSON.parse(body.toString()) as { text?: unknown }).text ?? '').trim().toLowerCase();
      if (!t) return this.send(res, 400, { error: 'пустой запрос' });
      const w = WORDS[t] ?? [0.3, 0.3, 0.3];
      return this.send(res, 200, { model: this.model, dim: 4, vector: pack([...w, 0.05]) });
    }
    this.send(res, 404, { error: 'нет такого адреса' });
  }
}
