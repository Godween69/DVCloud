// Помощник входа против поддельной страницы входа (локальный сервер с кнопкой QR и холстом), настоящий Chromium.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { createLoginApp } from '../server.mjs';

const CHROME = process.env.CHROMIUM_PATH || ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
const TOKEN = 'login-test-token-'.padEnd(40, 'x');

describe('помощник входа', { skip: CHROME ? false : 'нет Chromium для проверки' }, () => {
  let site, siteBase, app, base;
  let confirmed = false;
  const call = (method, path, auth = true) => fetch(base + path, { method, headers: auth ? { authorization: `Bearer ${TOKEN}` } : {} });
  const wait = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 150)); } return false; };

  before(async () => {
    site = createServer((req, res) => {
      if (req.url.startsWith('/confirm')) { confirmed = true; return res.writeHead(200).end('ok'); }
      if (req.url.startsWith('/disk')) {
        res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': ['sessionid2=s2; Path=/', 'yandexuid=u1; Path=/'] });
        return res.end('<h1>disk</h1>');
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><body><button onclick="document.getElementById('c').style.display='block'">Войти по QR-коду</button>
        <canvas id="c" width="120" height="120" style="display:none;background:#000"></canvas>
        <script>setInterval(async()=>{ if((await (await fetch('/state')).text())==='1'){ document.cookie='Session_id=S1; path=/'; } },300)</script></body>`);
    });
    // состояние подтверждения читает страница через /state
    const orig = site.listeners('request')[0];
    site.removeAllListeners('request');
    site.on('request', (req, res) => (req.url === '/state' ? res.writeHead(200).end(confirmed ? '1' : '0') : orig(req, res)));
    await new Promise((r) => site.listen(0, '127.0.0.1', r));
    siteBase = `http://127.0.0.1:${site.address().port}`;
    app = createLoginApp({ token: TOKEN, chromiumPath: CHROME, loginUrl: `${siteBase}/`, diskUrl: `${siteBase}/disk`, cookieDomain: '127.0.0.1', waitMs: 30000, pollMs: 300 });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${app.server.address().port}`;
  });
  after(async () => { await app.close(); site.close(); });

  it('без токена и с чужим токеном не пускает; health открыт', async () => {
    assert.equal((await call('POST', '/login', false)).status, 401);
    assert.equal((await fetch(base + '/login', { method: 'POST', headers: { authorization: 'Bearer ' + 'z'.repeat(40) } })).status, 401);
    assert.equal((await fetch(base + '/health')).status, 200);
    assert.equal((await call('GET', '/login/' + 'a'.repeat(32))).status, 404);
  });

  it('вход: QR появляется, до подтверждения ожидание, после него куки; DELETE стирает', async () => {
    const { id } = await (await call('POST', '/login')).json();
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.ok(await wait(async () => { const r = await call('GET', `/login/${id}/qr`); return r.status === 200 && r.headers.get('content-type') === 'image/png'; }), 'QR получен');
    const png = Buffer.from(await (await call('GET', `/login/${id}/qr`)).arrayBuffer());
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.deepEqual(await (await call('GET', `/login/${id}`)).json(), { state: 'waiting' });
    confirmed = true;
    let st;
    assert.ok(await wait(async () => { st = await (await call('GET', `/login/${id}`)).json(); return st.state !== 'waiting'; }));
    assert.equal(st.state, 'done', JSON.stringify(st));
    assert.deepEqual(st.cookies.map((c) => c.name).sort(), ['Session_id', 'sessionid2', 'yandexuid']);
    assert.equal((await call('DELETE', `/login/${id}`)).status, 200);
    assert.equal((await call('GET', `/login/${id}`)).status, 404, 'после стирания входа нет');
  });

  it('лишних входов сразу не больше двух', async () => {
    confirmed = false;
    const a = (await (await call('POST', '/login')).json()).id;
    const b = (await (await call('POST', '/login')).json()).id;
    assert.equal((await call('POST', '/login')).status, 429);
    await call('DELETE', `/login/${a}`);
    await call('DELETE', `/login/${b}`);
  });
});
