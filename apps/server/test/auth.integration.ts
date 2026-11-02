// Интеграционные тесты на настоящем Postgres. Запуск: npm run test:db (нужен DVCLOUD_TEST_DATABASE_URL).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApps } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { createTestDb } from './helpers/testdb';

const ADMIN_URL = process.env.DVCLOUD_TEST_DATABASE_URL;
if (!ADMIN_URL) throw new Error('Не задан DVCLOUD_TEST_DATABASE_URL: интеграционные тесты без базы не запускаются');

const TOKEN = 'integration-test-token-'.padEnd(40, 'x');

interface Res {
  status: number;
  json: any;
  cookie: string | null;
}

describe('вход и пользователи (настоящий Postgres)', () => {
  let drop: () => Promise<void>;
  let pub: Awaited<ReturnType<typeof createApps>>['pub'];
  let internal: Awaited<ReturnType<typeof createApps>>['internal'];
  let pubBase = '';
  let intBase = '';

  async function call(base: string, method: string, path: string, opts: { body?: unknown; cookie?: string; token?: string | null; raw?: string } = {}): Promise<Res> {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined || opts.raw !== undefined) headers['content-type'] = opts.raw !== undefined ? 'text/plain' : 'application/json';
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.token !== null && base === intBase) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
    const r = await fetch(base + path, {
      method,
      headers,
      body: opts.raw !== undefined ? opts.raw : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* не JSON */
    }
    return { status: r.status, json, cookie: r.headers.get('set-cookie') };
  }
  const sid = (setCookie: string | null): string => (setCookie ?? '').split(';')[0];
  const pubCall = (m: string, p: string, o = {}) => call(pubBase, m, p, o);
  const intCall = (m: string, p: string, o = {}) => call(intBase, m, p, o);
  const createUser = async (login: string) => (await intCall('POST', '/internal/users', { body: { login, displayName: login } })).json.password as string;
  const doLogin = (login: string, password: string) => pubCall('POST', '/api/auth/login', { body: { login, password } });

  before(async () => {
    const db = await createTestDb(ADMIN_URL);
    drop = db.drop;
    const cfg = loadConfig({
      DVCLOUD_DATABASE_URL: db.url,
      DVCLOUD_INTERNAL_TOKEN: TOKEN,
      DVCLOUD_COOKIE_SECURE: 'true',
    });
    ({ pub, internal } = await createApps(cfg, true));
    await pub.listen(0, '127.0.0.1');
    await internal.listen(0, '127.0.0.1');
    pubBase = `http://127.0.0.1:${(pub.getHttpServer().address() as AddressInfo).port}`;
    intBase = `http://127.0.0.1:${(internal.getHttpServer().address() as AddressInfo).port}`;
  });

  after(async () => {
    await pub?.close();
    await internal?.close();
    await drop?.();
  });

  it('внутренний порт закрыт без токена и с чужим токеном', async () => {
    assert.equal((await intCall('GET', '/internal/users', { token: null })).status, 401);
    assert.equal((await intCall('GET', '/internal/users', { token: 'wrong'.repeat(10) })).status, 401);
    assert.equal((await intCall('GET', '/internal/health', { token: null })).status, 200);
  });

  it('создание человека: пароль выдаётся один раз, хеш наружу не уходит', async () => {
    const r = await intCall('POST', '/internal/users', { body: { login: 'anna', displayName: 'Анна' } });
    assert.equal(r.status, 201);
    assert.match(r.json.password, /^[a-z2-9]{16}$/);
    assert.equal(r.json.user.login, 'anna');
    assert.ok(!JSON.stringify(r.json).includes('scrypt$'));
    const list = await intCall('GET', '/internal/users');
    assert.ok(!JSON.stringify(list.json).includes('scrypt$'));
    assert.ok(!JSON.stringify(list.json).includes('password_hash'));
  });

  it('дубль логина даёт 409, плохой логин и короткий пароль 400', async () => {
    assert.equal((await intCall('POST', '/internal/users', { body: { login: 'anna', displayName: 'X' } })).status, 409);
    assert.equal((await intCall('POST', '/internal/users', { body: { login: 'Bad Login', displayName: 'X' } })).status, 400);
    assert.equal((await intCall('POST', '/internal/users', { body: { login: 'newbie', displayName: 'X', password: 'short' } })).status, 400);
    assert.equal((await intCall('POST', '/internal/users', { raw: 'login=a' })).status, 415);
  });

  it('вход: кука HttpOnly+Secure+SameSite, /me узнаёт, выход закрывает сессию', async () => {
    const pw = await createUser('boris');
    const r = await doLogin('boris', pw);
    assert.equal(r.status, 200);
    assert.match(r.cookie ?? '', /dvcloud_sid=[A-Za-z0-9_-]{43};/);
    assert.match(r.cookie ?? '', /HttpOnly/);
    assert.match(r.cookie ?? '', /Secure/);
    assert.match(r.cookie ?? '', /SameSite=Lax/);
    const cookie = sid(r.cookie);
    const me = await pubCall('GET', '/api/auth/me', { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.json.user.login, 'boris');
    assert.equal((await pubCall('POST', '/api/auth/logout', { cookie, body: {} })).status, 200);
    assert.equal((await pubCall('GET', '/api/auth/me', { cookie })).status, 401);
  });

  it('без входа /me даёт 401, выдуманная кука не проходит', async () => {
    assert.equal((await pubCall('GET', '/api/auth/me')).status, 401);
    assert.equal((await pubCall('GET', '/api/auth/me', { cookie: `dvcloud_sid=${'a'.repeat(43)}` })).status, 401);
  });

  it('неверный пароль и несуществующий логин отвечают одинаково', async () => {
    await createUser('vera');
    const a = await doLogin('vera', 'definitely-wrong-password');
    const b = await doLogin('nobody_here', 'definitely-wrong-password');
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.deepEqual(a.json, b.json);
  });

  it('после 5 неудач вход блокируется, даже с верным паролем', async () => {
    const pw = await createUser('gleb');
    for (let i = 0; i < 5; i++) assert.equal((await doLogin('gleb', 'wrong-password-x')).status, 401);
    assert.equal((await doLogin('gleb', pw)).status, 429);
  });

  it('отключённый человек не входит, его сессия перестаёт работать', async () => {
    const pw = await createUser('dina');
    const cookie = sid((await doLogin('dina', pw)).cookie);
    assert.equal((await pubCall('GET', '/api/auth/me', { cookie })).status, 200);
    const off = await intCall('PATCH', '/internal/users/dina', { body: { disabled: true } });
    assert.equal(off.status, 200);
    assert.equal((await pubCall('GET', '/api/auth/me', { cookie })).status, 401);
    assert.equal((await doLogin('dina', pw)).status, 401);
    await intCall('PATCH', '/internal/users/dina', { body: { disabled: false } });
    assert.equal((await doLogin('dina', pw)).status, 200);
  });

  it('сброс пароля завершает сессии; старый пароль не работает, новый работает', async () => {
    const pw = await createUser('egor');
    const cookie = sid((await doLogin('egor', pw)).cookie);
    const reset = await intCall('POST', '/internal/users/egor/reset-password', { body: {} });
    assert.equal(reset.status, 200);
    assert.equal((await pubCall('GET', '/api/auth/me', { cookie })).status, 401);
    assert.equal((await doLogin('egor', pw)).status, 401);
    assert.equal((await doLogin('egor', reset.json.password)).status, 200);
  });

  it('квота: целое число байт или null; мусор отвергается', async () => {
    await createUser('zoya');
    const ok = await intCall('PATCH', '/internal/users/zoya', { body: { quotaBytes: 500000000000 } });
    assert.equal(ok.json.user.quotaBytes, 500000000000);
    assert.equal((await intCall('PATCH', '/internal/users/zoya', { body: { quotaBytes: null } })).json.user.quotaBytes, null);
    assert.equal((await intCall('PATCH', '/internal/users/zoya', { body: { quotaBytes: -5 } })).status, 400);
    assert.equal((await intCall('PATCH', '/internal/users/zoya', { body: { quotaBytes: 'много' } })).status, 400);
    assert.equal((await intCall('PATCH', '/internal/users/nobody_here', { body: { disabled: true } })).status, 404);
  });

  it('вход и выход принимают только JSON', async () => {
    const r = await call(pubBase, 'POST', '/api/auth/login', { raw: 'login=a&password=b' });
    assert.equal(r.status, 415);
  });
});
