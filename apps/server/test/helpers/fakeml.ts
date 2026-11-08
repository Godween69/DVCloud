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
    if (method === 'GET' && url === '/health') return this.send(res, 200, { ok: true, model: this.model, ready: this.ready, loaded: null, dim: 4 });
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
