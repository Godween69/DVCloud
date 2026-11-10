import { createHash, randomInt } from 'node:crypto';
import { Readable, Transform, TransformCallback } from 'node:stream';

// Клиент Диска по сессии человека (куки), только чтение. Неофициальный путь: тот же внутренний API, что у сайта Диска.
// Ничего здесь не пишет на Диск и не печатает куки и ссылки на файлы.

// Сессия не принята: куки устарели или Яндекс просит войти заново.
export class YandexAuthError extends Error {}
// Яндекс не ответил или ответил сбоем: куки при этом могут быть живы, повторить позже.
export class YandexUnavailable extends Error {}
// Слишком частые запросы (лимит или капча): надо помолчать.
export class YandexRateLimit extends Error {
  constructor(
    message: string,
    readonly retryAfterSec = 300,
  ) {
    super(message);
  }
}
// Яндекс говорит, что такого файла нет (удалён после чтения списка).
export class YandexGone extends Error {}

export interface ListedFile {
  path: string;
  name: string;
  size: number;
  md5: string | null;
  mtime: Date | null;
}

export const UNLIM_ROOT = '/photounlim';
const PAGE = 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MIN_MTIME = Date.UTC(1990, 0, 1);

export function parseMtime(v: unknown): Date | null {
  let ms: number;
  if (typeof v === 'number' && Number.isFinite(v)) ms = v > 1e12 ? v : v * 1000;
  else if (typeof v === 'string' && v.trim() !== '') ms = /^\d+$/.test(v.trim()) ? (Number(v) > 1e12 ? Number(v) : Number(v) * 1000) : Date.parse(v);
  else return null;
  return Number.isFinite(ms) && ms >= MIN_MTIME && ms <= Date.now() + 86_400_000 ? new Date(ms) : null;
}

// Что нашлось в одном ответе списка: файлы безлимита (путь под /photounlim/), без папок.
export function parseListPage(page: unknown): ListedFile[] {
  if (!Array.isArray(page)) throw new YandexUnavailable(`Список безлимита: ожидался массив, пришёл ${typeof page}`);
  const out: ListedFile[] = [];
  for (const f of page as Record<string, any>[]) {
    const path = typeof f?.path === 'string' ? f.path : '';
    if (!path.startsWith(`${UNLIM_ROOT}/`) || f.type === 'dir') continue;
    const meta = (f.meta ?? {}) as Record<string, unknown>;
    const md5 = typeof meta.md5 === 'string' && /^[0-9a-f]{32}$/i.test(meta.md5) ? meta.md5.toLowerCase() : null;
    out.push({
      path,
      name: typeof f.name === 'string' && f.name ? f.name : path.slice(path.lastIndexOf('/') + 1),
      size: Number(meta.size) > 0 ? Number(meta.size) : 0,
      md5,
      mtime: parseMtime(f.mtime ?? meta.mtime ?? f.ctime),
    });
  }
  return out;
}

export interface Download {
  stream: Readable;
  length: number | null; // размер по заголовку ответа
  md5: () => string; // контрольная сумма скачанного (после конца потока)
  bytes: () => number;
}

export class YandexDisk {
  private sk = '';
  private uid = '';
  private readonly baseHost: string;

  constructor(
    private readonly base: string,
    private readonly cookies: Record<string, string>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseHost = new URL(base).hostname;
  }

  // Куки уходят только на Диск и его поддомены Яндекса, но не на чужие адреса, куда мог бы вести редирект.
  private cookieFor(url: string): string | null {
    const h = new URL(url).hostname;
    if (h !== this.baseHost && !h.endsWith('.yandex.ru') && !h.endsWith('.yandex.net')) return null;
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private headers(url: string, extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { 'user-agent': UA, accept: '*/*', 'accept-language': 'ru,en;q=0.9', ...extra };
    const c = this.cookieFor(url);
    if (c) h.cookie = c;
    return h;
  }

  private async send(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new YandexUnavailable(`Яндекс не ответил (${(e as Error).name === 'TimeoutError' ? 'время вышло' : 'сеть'})`);
    }
  }

  // Заходит на страницу Диска, берёт оттуда sk и uid для запросов. Нужно один раз на сессию.
  async open(): Promise<void> {
    const url = `${this.base}/client/disk`;
    const r = await this.send(url, { headers: this.headers(url) }, 30_000);
    const loc = r.headers.get('location') ?? '';
    if (r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400 && /passport\.yandex/.test(loc))) {
      await r.body?.cancel();
      throw new YandexAuthError('Сессия Яндекса не принята');
    }
    if (r.status === 429) throw new YandexRateLimit('Яндекс просит не частить');
    if (r.status !== 200) {
      await r.body?.cancel();
      throw new YandexUnavailable(`Страница Диска ответила HTTP ${r.status}`);
    }
    const html = await r.text();
    if (/passport\.yandex\.[a-z]+\/auth/.test(r.url)) throw new YandexAuthError('Сессия Яндекса не принята');
    const sk = /"sk"\s*:\s*"([^"]+)"/.exec(html);
    const uid = /"uid"\s*:\s*"?(\d+)"?/.exec(html);
    if (!sk || !uid) throw new YandexUnavailable('На странице Диска нет ключей запроса: Яндекс изменил формат');
    this.sk = sk[1];
    this.uid = uid[1];
  }

  get accountId(): string {
    return this.uid;
  }

  // Вызов внутреннего API Диска. Ошибки разложены по видам, чтобы очередь знала, что делать.
  async api(method: string, params: unknown, timeoutMs = 120_000): Promise<unknown> {
    if (!this.sk) await this.open();
    const url = `${this.base}/models-v2?m=${encodeURIComponent(method)}`;
    const body = JSON.stringify({ sk: this.sk, connection_id: `${this.uid}${Date.now()}${randomInt(100, 999)}`, apiMethod: method, requestParams: params });
    const r = await this.send(url, { method: 'POST', body, headers: this.headers(url, { 'content-type': 'application/json', origin: this.base, referer: `${this.base}/client/photo`, 'x-requested-with': 'XMLHttpRequest' }) }, timeoutMs);
    const text = await r.text();
    if (r.status === 401 || r.status === 403) throw new YandexAuthError(`Сессия истекла (HTTP ${r.status})`);
    if (r.status === 429 || /captcha/i.test(text.slice(0, 2000))) throw new YandexRateLimit('Яндекс просит не частить (лимит или капча)', Number(r.headers.get('retry-after')) || 300);
    if (r.status === 404) throw new YandexGone('Яндекс: такого файла нет');
    if (r.status !== 200) throw new YandexUnavailable(`${method}: HTTP ${r.status}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new YandexUnavailable(`${method}: ответ не JSON`);
    }
  }

  // Весь безлимит постранично. Идёт, пока страницы дают новые файлы.
  async *listUnlim(): AsyncGenerator<ListedFile[]> {
    const seen = new Set<string>();
    for (let offset = 0; offset < 2_000_000; offset += PAGE) {
      const page = parseListPage(await this.api('mpfs/list', { path: UNLIM_ROOT, amount: PAGE, offset, meta: 'size,md5,mimetype,mediatype' }));
      const fresh = page.filter((f) => !seen.has(f.path));
      if (fresh.length === 0) return;
      for (const f of fresh) seen.add(f.path);
      yield fresh;
    }
  }

  // Прямая ссылка на оригинал одного файла (живёт недолго: качать сразу).
  async fileUrl(path: string): Promise<string> {
    const d = (await this.api('mpfs/url', { path }, 60_000)) as Record<string, unknown> | null;
    if (!d || typeof d !== 'object') throw new YandexUnavailable('Яндекс не выдал ссылку на файл');
    if (d.error) {
      const e = d.error as Record<string, unknown> | string;
      const text = typeof e === 'string' ? e : String(e.title ?? e.id ?? '');
      if (/not\s*found|не найден/i.test(text)) throw new YandexGone('Яндекс: такого файла нет');
      throw new YandexUnavailable(`Яндекс не выдал ссылку: ${text.slice(0, 120)}`);
    }
    const f = d.file;
    if (typeof f !== 'string' || !f) throw new YandexUnavailable('В ответе Яндекса нет ссылки на файл');
    return f.startsWith('//') ? `https:${f}` : f;
  }

  // Скачивание потоком. Редиректы идут вручную (до 5), куки уходят только на адреса Яндекса. Нет данных дольше idleMs = обрыв.
  async download(url: string, idleMs = 60_000): Promise<Download> {
    let cur = url;
    let res: Response | null = null;
    for (let hop = 0; hop < 6; hop++) {
      const r = await this.send(cur, { headers: this.headers(cur) }, 60_000);
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
        cur = new URL(r.headers.get('location')!, cur).toString();
        await r.body?.cancel();
        continue;
      }
      res = r;
      break;
    }
    if (!res) throw new YandexUnavailable('Слишком много перенаправлений при скачивании');
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      throw new YandexAuthError(`Скачивание не разрешено (HTTP ${res.status})`);
    }
    if (res.status === 404) {
      await res.body?.cancel();
      throw new YandexGone('Яндекс: такого файла нет');
    }
    if (res.status === 429) {
      await res.body?.cancel();
      throw new YandexRateLimit('Яндекс просит не частить');
    }
    if (res.status !== 200 || !res.body) {
      await res.body?.cancel();
      throw new YandexUnavailable(`Сервер хранения ответил HTTP ${res.status}`);
    }
    if ((res.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) {
      await res.body.cancel();
      throw new YandexUnavailable('Вместо файла пришла страница');
    }
    const len = Number(res.headers.get('content-length'));
    const md5 = createHash('md5');
    let bytes = 0;
    let timer: NodeJS.Timeout | null = null;
    const hasher = new Transform({
      transform(chunk: Buffer, _enc, cb: TransformCallback) {
        md5.update(chunk);
        bytes += chunk.length;
        arm();
        cb(null, chunk);
      },
      flush(cb) {
        if (timer) clearTimeout(timer);
        cb();
      },
      destroy(err, cb) {
        if (timer) clearTimeout(timer);
        cb(err);
      },
    });
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => hasher.destroy(new YandexUnavailable('Яндекс перестал отдавать файл (нет данных)')), idleMs);
      timer.unref();
    };
    arm();
    const src = Readable.fromWeb(res.body as never);
    src.on('error', (e) => hasher.destroy(e instanceof YandexUnavailable ? e : new YandexUnavailable('Обрыв при скачивании')));
    src.pipe(hasher);
    return { stream: hasher, length: Number.isFinite(len) && len > 0 ? len : null, md5: () => md5.digest('hex'), bytes: () => bytes };
  }
}
