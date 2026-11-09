// Помощник входа в Яндекс по QR. Отдельная маленькая служба: по просьбе сервера DV Cloud открывает страницу входа Яндекса
// в браузере без окна, отдаёт картинку QR, ждёт, пока человек подтвердит вход в приложении на телефоне, и отдаёт серверу
// куки сессии. Пароль человека сюда никогда не попадает. Всё, что связано со входом, стирается сразу после выдачи или по таймеру.
// Служба наружу не публикуется: с ней разговаривает только сервер, по общему секрету (заголовок Authorization: Bearer).
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chromium } from 'playwright-core';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const NEED = ['Session_id', 'yandexuid', 'sessionid2'];

export function createLoginApp(opts = {}) {
  const cfg = {
    token: opts.token ?? process.env.DVCLOUD_YANDEX_LOGIN_TOKEN ?? '',
    chromiumPath: opts.chromiumPath ?? process.env.CHROMIUM_PATH ?? '/usr/bin/chromium-browser',
    loginUrl: opts.loginUrl ?? process.env.LOGIN_PAGE_URL ?? 'https://passport.yandex.ru/auth?retpath=https%3A%2F%2Fdisk.yandex.ru%2Fclient%2Fdisk',
    diskUrl: opts.diskUrl ?? process.env.DISK_PAGE_URL ?? 'https://disk.yandex.ru/client/disk',
    cookieDomain: opts.cookieDomain ?? process.env.COOKIE_DOMAIN ?? 'yandex',
    waitMs: opts.waitMs ?? Number(process.env.LOGIN_WAIT_SEC ?? 300) * 1000,
    pollMs: opts.pollMs ?? 2000,
    maxSessions: opts.maxSessions ?? 2,
    noSandbox: opts.noSandbox ?? (process.env.CHROMIUM_NO_SANDBOX ?? '1') === '1',
  };
  if (cfg.token.length < 32) throw new Error('DVCLOUD_YANDEX_LOGIN_TOKEN должен быть не короче 32 символов');
  const sessions = new Map();

  const authorized = (req) => {
    const got = Buffer.from(req.headers.authorization ?? '');
    const want = Buffer.from(`Bearer ${cfg.token}`);
    return got.length === want.length && timingSafeEqual(got, want);
  };
  const json = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));

  // QR: ищем сам элемент (картинка или холст), иначе отдаём снимок всей страницы.
  async function snap(s) {
    for (const sel of ['img[src*="qr" i]', 'canvas', '[class*="qr" i] img', '[class*="qr" i]']) {
      try {
        const loc = s.page.locator(sel).first();
        if ((await loc.count()) && (await loc.isVisible())) {
          s.qr = await loc.screenshot();
          return;
        }
      } catch { /* пробуем следующий признак */ }
    }
    s.qr = await s.page.screenshot();
  }

  async function openQrTab(page) {
    for (const re of [/qr/i, /по\s*qr/i, /qr-код/i]) {
      try {
        await page.getByText(re).first().click({ timeout: 2500 });
        return true;
      } catch { /* нет такой кнопки */ }
    }
    return false;
  }

  async function wipe(s) {
    clearTimeout(s.timer);
    s.stopped = true;
    s.qr = null;
    s.cookies = null;
    try { await s.browser?.close(); } catch { /* уже закрыт */ }
  }

  async function run(s) {
    try {
      s.browser = await chromium.launch({
        executablePath: cfg.chromiumPath,
        headless: true,
        args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', ...(cfg.noSandbox ? ['--no-sandbox'] : [])],
      });
      const ctx = await s.browser.newContext({ userAgent: UA, locale: 'ru-RU', viewport: { width: 1100, height: 800 } });
      s.page = await ctx.newPage();
      await s.page.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await new Promise((r) => setTimeout(r, 2500));
      await openQrTab(s.page);
      await new Promise((r) => setTimeout(r, 1500));
      const t0 = Date.now();
      let lastReload = Date.now();
      while (!s.stopped && Date.now() - t0 < cfg.waitMs) {
        await snap(s);
        const names = new Set((await ctx.cookies()).map((c) => c.name));
        if (names.has('Session_id')) {
          await s.page.goto(cfg.diskUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          await new Promise((r) => setTimeout(r, 4000));
          const jar = (await ctx.cookies()).filter((c) => (c.domain ?? '').includes(cfg.cookieDomain));
          const have = new Set(jar.map((c) => c.name));
          if (!NEED.every((n) => have.has(n))) {
            s.state = 'failed';
            s.note = 'Яндекс не выдал нужные данные входа. Попробуйте ещё раз.';
          } else {
            s.cookies = jar.map((c) => ({ name: c.name, value: c.value, domain: c.domain }));
            s.state = 'done';
          }
          break;
        }
        if (Date.now() - lastReload > 55_000) {
          await s.page.reload({ waitUntil: 'domcontentloaded' });
          await new Promise((r) => setTimeout(r, 2000));
          await openQrTab(s.page);
          lastReload = Date.now();
        }
        await new Promise((r) => setTimeout(r, cfg.pollMs));
      }
      if (s.state === 'waiting' && !s.stopped) {
        s.state = 'failed';
        s.note = 'Вход не подтверждён вовремя. Начните заново.';
      }
    } catch (e) {
      if (!s.stopped) {
        s.state = 'failed';
        s.note = 'Не удалось открыть страницу входа Яндекса.';
        console.error('login: ' + (e instanceof Error ? e.message : e));
      }
    } finally {
      // браузер больше не нужен: куки уже у нас в памяти до выдачи серверу
      try { await s.browser?.close(); } catch { /* уже закрыт */ }
      s.qr = null;
      if (s.state !== 'done') s.cookies = null;
    }
  }

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') return json(res, 200, { status: 'ok', service: 'dvcloud-login' });
      if (!authorized(req)) return json(res, 401, { message: 'нужен токен' });
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'POST' && url.pathname === '/login') {
        if ([...sessions.values()].filter((s) => !s.stopped).length >= cfg.maxSessions) return json(res, 429, { message: 'Слишком много входов сразу' });
        const id = randomBytes(16).toString('hex');
        const s = { id, state: 'waiting', note: '', qr: null, cookies: null, stopped: false, timer: null };
        s.timer = setTimeout(() => { sessions.delete(id); void wipe(s); }, cfg.waitMs + 120_000); // брошенный вход стирается сам
        s.timer.unref();
        sessions.set(id, s);
        void run(s);
        return json(res, 200, { id });
      }
      const m = /^\/login\/([0-9a-f]{32})(\/qr)?$/.exec(url.pathname);
      const s = m ? sessions.get(m[1]) : null;
      if (!m || !s) return json(res, 404, { message: 'вход не найден' });
      if (req.method === 'GET' && m[2]) {
        if (!s.qr) return res.writeHead(204, { 'cache-control': 'no-store' }).end();
        return res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }).end(s.qr);
      }
      if (req.method === 'GET') {
        if (s.state === 'done') return json(res, 200, { state: 'done', cookies: s.cookies });
        if (s.state === 'failed') return json(res, 200, { state: 'failed', note: s.note });
        return json(res, 200, { state: 'waiting' });
      }
      if (req.method === 'DELETE') {
        sessions.delete(m[1]);
        await wipe(s);
        return json(res, 200, {});
      }
      return json(res, 405, { message: 'нельзя' });
    } catch (e) {
      console.error('login: ' + (e instanceof Error ? e.message : e));
      return json(res, 500, { message: 'ошибка помощника входа' });
    }
  });

  return {
    server,
    async close() {
      for (const s of sessions.values()) await wipe(s);
      sessions.clear();
      await new Promise((r) => server.close(r));
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createLoginApp();
  const port = Number(process.env.PORT ?? 8099);
  app.server.listen(port, process.env.HOST ?? '0.0.0.0', () => console.log(`dvcloud-login слушает порт ${port}`));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => void app.close().then(() => process.exit(0)));
}
