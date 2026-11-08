// Проверка админки целиком с поддельным внутренним сервером (без базы и без сети).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createAdminApp } from '../server.mjs';
import { createApi } from '../lib/api.mjs';
import { hashPassword } from '../lib/password.mjs';

const TOKEN = 't'.repeat(40);
const PASSWORD = 'correct horse battery';

describe('админка', () => {
  let fake, admin, base, port;
  const users = [{ id: '1', login: 'anna', displayName: '<img src=x onerror=alert(1)>', isAdmin: false, disabled: false, quotaBytes: null, createdAt: '2026-11-02T00:00:00.000Z' }];
  const calls = [];

  before(async () => {
    fake = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const j = (status, obj) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        if (req.headers.authorization !== `Bearer ${TOKEN}`) return j(401, { message: 'Нужен токен' });
        calls.push(`${req.method} ${req.url} ${body}`);
        if (req.method === 'GET' && req.url === '/internal/users') return j(200, { users });
        if (req.method === 'POST' && req.url === '/internal/users') {
          const b = JSON.parse(body);
          if (users.some((u) => u.login === b.login)) return j(409, { message: 'Такой логин уже есть' });
          const user = { ...users[0], id: '2', login: b.login, displayName: b.displayName };
          users.push(user);
          return j(201, { user, password: 'abcd2345efgh6789' });
        }
        const m = /^\/internal\/users\/([a-z0-9_]+)(\/reset-password)?$/.exec(req.url);
        if (m && req.method === 'PATCH') return j(200, { user: { ...users[0], ...JSON.parse(body) } });
        if (/^\/internal\/users\/[a-z0-9_]+\/reset-2fa$/.test(req.url)) return j(200, { ok: true });
        if (m && m[2]) return j(200, { password: 'newpass23456789zz' });
        if (req.method === 'GET' && req.url === '/internal/stats') return j(200, { files: 5, blobs: 4, orphans: 1, bytes: 1048576, extraCopies: 2 });
        if (req.method === 'GET' && req.url.startsWith('/internal/files/orphans')) return j(200, { orphans: [{ id: '7', name: '<b>x</b>.jpg', size: 2048, createdAt: '2026-11-01T10:00:00.000Z' }] });
        if (req.method === 'GET' && req.url === '/internal/albums') return j(200, { albums: [{ id: '3', name: 'Отпуск', owner: 'anna', count: 12, sharedWith: 1 }] });
        if (req.method === 'GET' && req.url === '/internal/quota-requests') return j(200, { requests: [{ id: '9', login: 'anna', displayName: 'Анна', needBytes: 5368709120, note: 'отпуск', createdAt: '2026-11-02T00:00:00.000Z', usedBytes: 1073741824, quotaBytes: 2147483648 }] });
        if (req.method === 'POST' && req.url === '/internal/files/dedupe') return j(200, { checked: 2, removed: JSON.parse(body).apply ? 2 : 0, freedBytes: 4096, mismatched: [] });
        if (req.method === 'POST' && /^\/internal\/files\/\d+\/purge$/.test(req.url)) return j(200, { links: 0, bytes: 2048 });
        if (req.method === 'POST' && /^\/internal\/files\/\d+\/adopt$/.test(req.url)) return j(200, { fileId: '55' });
        if (req.method === 'POST' && /^\/internal\/albums\/\d+\/transfer$/.test(req.url)) return j(200, { albumId: '4', linked: 12 });
        if (req.method === 'DELETE' && /^\/internal\/albums\/\d+$/.test(req.url)) return j(200, { ok: true });
        if (req.method === 'POST' && /^\/internal\/quota-requests\/\d+\/resolve$/.test(req.url)) return j(200, { ok: true });
        if (req.method === 'DELETE' && /^\/internal\/users\/[a-z0-9_]+/.test(req.url)) return j(200, { links: 3 });
        j(404, { message: 'нет' });
      });
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const api = createApi({ baseUrl: `http://127.0.0.1:${fake.address().port}`, token: TOKEN });
    admin = createAdminApp({ cfg: { passwordHash: hashPassword(PASSWORD), extraHosts: [], cookieSecure: false }, api });
    await new Promise((r) => admin.listen(0, '127.0.0.1', r));
    port = admin.address().port;
    base = `http://127.0.0.1:${port}`;
  });

  after(() => {
    admin.close();
    fake.close();
  });

  // Запрос через node:http, чтобы управлять заголовком Host.
  const req = (method, path, { form, cookie, host } = {}) =>
    new Promise((resolve, reject) => {
      const body = form ? new URLSearchParams(form).toString() : undefined;
      const r = request(
        { host: '127.0.0.1', port, method, path, headers: { host: host ?? `127.0.0.1:${port}`, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } : {}) } },
        (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
        },
      );
      r.on('error', reject);
      if (body) r.write(body);
      r.end();
    });

  async function login() {
    const r = await req('POST', '/login', { form: { password: PASSWORD } });
    assert.equal(r.status, 303);
    return r.headers['set-cookie'][0].split(';')[0];
  }
  const csrfOf = (page) => /name="csrf" value="([^"]+)"/.exec(page)[1];

  it('чужой Host отвергается (защита от DNS rebinding)', async () => {
    assert.equal((await req('GET', '/login', { host: 'evil.example' })).status, 400);
  });

  it('без входа всё ведёт на страницу входа, заголовки защиты на месте', async () => {
    const r = await req('GET', '/');
    assert.equal(r.status, 303);
    assert.equal(r.headers.location, '/login');
    const p = await req('GET', '/login');
    assert.match(p.headers['content-security-policy'], /default-src 'none'/);
    assert.equal(p.headers['x-frame-options'], 'DENY');
  });

  it('вход: кука HttpOnly+SameSite=Strict, список людей, имена экранированы', async () => {
    const r = await req('POST', '/login', { form: { password: PASSWORD } });
    assert.match(r.headers['set-cookie'][0], /HttpOnly/);
    assert.match(r.headers['set-cookie'][0], /SameSite=Strict/);
    const cookie = r.headers['set-cookie'][0].split(';')[0];
    const page = await req('GET', '/', { cookie });
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('anna'));
    assert.ok(!page.text.includes('<img src=x'), 'имя с разметкой не должно попасть в страницу как есть');
    assert.ok(page.text.includes('&lt;img src=x'));
  });

  it('создание человека показывает пароль один раз', async () => {
    const cookie = await login();
    const csrf = csrfOf((await req('GET', '/', { cookie })).text);
    const r = await req('POST', '/users', { cookie, form: { csrf, login: 'boris', displayName: 'Борис' } });
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('abcd2345efgh6789'));
    assert.equal(r.headers['cache-control'], 'no-store');
    const again = await req('GET', '/', { cookie });
    assert.ok(!again.text.includes('abcd2345efgh6789'));
  });

  it('дубль логина: сообщение об ошибке, пароль не показан', async () => {
    const cookie = await login();
    const csrf = csrfOf((await req('GET', '/', { cookie })).text);
    const r = await req('POST', '/users', { cookie, form: { csrf, login: 'anna', displayName: 'X' } });
    assert.equal(r.status, 303);
    const page = await req('GET', '/', { cookie });
    assert.ok(page.text.includes('Такой логин уже есть'));
  });

  it('отключение, квота и сброс пароля доходят до сервера', async () => {
    const cookie = await login();
    const csrf = csrfOf((await req('GET', '/', { cookie })).text);
    await req('POST', '/users/anna/disable', { cookie, form: { csrf } });
    await req('POST', '/users/anna/quota', { cookie, form: { csrf, quota: '500' } });
    const reset = await req('POST', '/users/anna/reset', { cookie, form: { csrf } });
    assert.ok(reset.text.includes('newpass23456789zz'));
    assert.ok(calls.some((c) => c.startsWith('PATCH /internal/users/anna') && c.includes('"disabled":true')));
    assert.ok(calls.some((c) => c.includes(`"quotaBytes":${500 * 1024 ** 3}`)));
  });

  it('сброс второго фактора: кнопка только у тех, у кого он включён, запрос доходит до сервера', async () => {
    const cookie = await login();
    users[0].twoFactor = true;
    let page = await req('GET', '/', { cookie });
    assert.ok(page.text.includes('Сбросить 2FA'));
    assert.ok(page.text.includes('включена'));
    const csrf = csrfOf(page.text);
    const r = await req('POST', '/users/anna/reset2fa', { cookie, form: { csrf } });
    assert.equal(r.status, 303);
    assert.ok(calls.some((c) => c.startsWith('POST /internal/users/anna/reset-2fa')));
    assert.equal((await req('POST', '/users/anna/reset2fa', { cookie, form: { csrf: 'wrong' } })).status, 403);
    users[0].twoFactor = false;
    page = await req('GET', '/', { cookie });
    assert.ok(!page.text.includes('Сбросить 2FA'));
  });

  it('плохая квота не уходит на сервер', async () => {
    const cookie = await login();
    const csrf = csrfOf((await req('GET', '/', { cookie })).text);
    const before = calls.length;
    await req('POST', '/users/anna/quota', { cookie, form: { csrf, quota: 'много' } });
    assert.equal(calls.length, before);
  });

  it('запрос без токена защиты от подделки отклоняется', async () => {
    const cookie = await login();
    assert.equal((await req('POST', '/users/anna/disable', { cookie, form: { csrf: 'wrong' } })).status, 403);
    assert.equal((await req('POST', '/users/anna/disable', { cookie, form: {} })).status, 403);
  });

  it('страница «Хранилище»: сводка, просьбы, файлы без владельца, альбомы; имена экранированы', async () => {
    const cookie = await login();
    const page = await req('GET', '/storage', { cookie });
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('Отпуск'));
    assert.ok(page.text.includes('отпуск'));
    assert.ok(page.text.includes('5,0 ГБ'));
    assert.ok(!page.text.includes('<b>x</b>'), 'имя файла с разметкой не должно попасть как есть');
    assert.ok(page.text.includes('&lt;b&gt;x&lt;/b&gt;'));
    assert.equal((await req('GET', '/storage')).status, 303, 'без входа не открывается');
  });

  it('хранилище: стереть, отдать, скопировать альбом, задать квоту, закрыть просьбу', async () => {
    const cookie = await login();
    const csrf = csrfOf((await req('GET', '/storage', { cookie })).text);
    const post = (path, form) => req('POST', path, { cookie, form: { csrf, ...form } });
    assert.equal((await post('/storage/files/7/purge', {})).status, 303);
    assert.ok(calls.some((c) => c.startsWith('POST /internal/files/7/purge')));
    await post('/storage/files/7/adopt', { login: 'anna' });
    assert.ok(calls.some((c) => c.startsWith('POST /internal/files/7/adopt') && c.includes('"login":"anna"')));
    await post('/storage/albums/3/transfer', { login: 'boris' });
    assert.ok(calls.some((c) => c.startsWith('POST /internal/albums/3/transfer') && c.includes('"move":false')));
    await post('/storage/albums/3/delete', {});
    assert.ok(calls.some((c) => c.startsWith('DELETE /internal/albums/3')));
    const before = calls.length;
    await post('/storage/requests/9/grant', { login: 'anna', quota: 'много' });
    assert.equal(calls.length, before, 'плохая квота не уходит на сервер');
    await post('/storage/requests/9/grant', { login: 'anna', quota: '20' });
    assert.ok(calls.some((c) => c.startsWith('PATCH /internal/users/anna') && c.includes(`"quotaBytes":${20 * 1024 ** 3}`)));
    assert.ok(calls.some((c) => c.startsWith('POST /internal/quota-requests/9/resolve')));
    await post('/storage/dedupe', { apply: '1' });
    const after = await req('GET', '/storage', { cookie });
    assert.ok(after.text.includes('удалено: 2'));
    assert.equal((await req('POST', '/storage/files/7/purge', { cookie, form: { csrf: 'wrong' } })).status, 403);
  });

  it('удаление аккаунта требует ввести логин; «с файлами» передаётся как force', async () => {
    const cookie = await login();
    const csrf = csrfOf((await req('GET', '/', { cookie })).text);
    const before = calls.length;
    await req('POST', '/users/anna/delete', { cookie, form: { csrf, confirm: 'не тот' } });
    assert.equal(calls.length, before);
    await req('POST', '/users/anna/delete', { cookie, form: { csrf, confirm: 'anna', force: '1' } });
    assert.ok(calls.some((c) => c.startsWith('DELETE /internal/users/anna?force=1')));
    await req('POST', '/users/anna/delete', { cookie, form: { csrf, confirm: 'anna' } });
    assert.ok(calls.some((c) => c.startsWith('DELETE /internal/users/anna ')));
  });

  it('выход закрывает сессию', async () => {
    const cookie = await login();
    const csrf = csrfOf((await req('GET', '/', { cookie })).text);
    await req('POST', '/logout', { cookie, form: { csrf } });
    assert.equal((await req('GET', '/', { cookie })).status, 303);
  });

  it('неверный пароль даёт 401, после 5 неудач вход блокируется даже с верным', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await req('POST', '/login', { form: { password: 'nope' } })).status, 401);
    assert.equal((await req('POST', '/login', { form: { password: PASSWORD } })).status, 429);
  });
});
