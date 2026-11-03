// Облако и второй фактор: проверяется, как сервер облака пользуется DV Auth. Сам DV Auth здесь подменён
// простой заглушкой (его собственные тесты лежат в репозитории DV Auth). Нужен DVCLOUD_TEST_DATABASE_URL.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApps } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { createTestDb } from './helpers/testdb';

const ADMIN_URL = process.env.DVCLOUD_TEST_DATABASE_URL;
if (!ADMIN_URL) throw new Error('Не задан DVCLOUD_TEST_DATABASE_URL: интеграционные тесты без базы не запускаются');
const TOKEN = 'integration-test-token-'.padEnd(40, 'x');
const AUTH_SECRET = 'auth-secret-'.padEnd(40, 's');
const GOOD = '123456';

interface Sub {
  enabled: boolean;
  totp: boolean;
}

describe('второй фактор в облаке (заглушка DV Auth)', () => {
  let drop: () => Promise<void>;
  let pub: Awaited<ReturnType<typeof createApps>>['pub'];
  let internal: Awaited<ReturnType<typeof createApps>>['internal'];
  let stub: Server;
  let pubBase = '';
  let intBase = '';
  let stubDown = false;
  let stubChatState = 'pending';
  let stubSecret = AUTH_SECRET;
  const subs = new Map<string, Sub>(); // человек (id в облаке) -> состояние
  const calls: { path: string; body: any }[] = [];

  async function call(base: string, method: string, path: string, o: { body?: unknown; cookie?: string } = {}) {
    const headers: Record<string, string> = {};
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    if (o.cookie) headers.cookie = o.cookie;
    if (base === intBase) headers.authorization = `Bearer ${TOKEN}`;
    const r = await fetch(base + path, { method, headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
    const t = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(t);
    } catch {
      /* не JSON */
    }
    return { status: r.status, json, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0] };
  }
  const p = (m: string, path: string, o = {}) => call(pubBase, m, '/api' + path, o);
  const i = (m: string, path: string, o = {}) => call(intBase, m, path, o);
  const newUser = async (login: string) => {
    const r = await i('POST', '/internal/users', { body: { login, displayName: login } });
    return { login, password: r.json.password as string, id: r.json.user.id as string };
  };
  const login = (u: { login: string; password: string }) => p('POST', '/auth/login', { body: { login: u.login, password: u.password } });

  before(async () => {
    stub = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (stubDown) return req.socket.destroy();
        const u = new URL(req.url ?? '/', 'http://x');
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        const out = (status: number, obj: unknown) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(obj));
        };
        if (req.headers.authorization !== `Bearer ${stubSecret}`) return out(401, { error: 'unauthorized', message: 'Неверный секрет приложения' });
        calls.push({ path: u.pathname, body: req.method === 'GET' ? { subject: u.searchParams.get('subject') } : body });
        const subject = String(body.subject ?? u.searchParams.get('subject') ?? '');
        const s = subs.get(subject) ?? { enabled: false, totp: false };
        switch (`${req.method} ${u.pathname}`) {
          case 'GET /v1/status':
            return out(200, { enabled: s.enabled, chatAvailable: true, chatLinked: s.enabled && !s.totp, matrixId: null, totpAvailable: true, totpEnabled: s.totp, recoveryLeft: 10, methods: ['chat'] });
          case 'GET /v1/subjects':
            return out(200, { subjects: [...subs].filter(([, v]) => v.enabled).map(([k]) => k) });
          case 'POST /v1/login/begin':
            return out(200, s.enabled ? { required: true, ticket: `ticket-${subject}-`.padEnd(30, 't'), methods: ['chat', 'totp', 'recovery'] } : { required: false });
          case 'POST /v1/login/code':
            return body.code === GOOD ? out(200, { ok: true, subject: String(body.ticket).split('-')[1] }) : out(401, { error: 'invalid_code', message: 'Неверный код' });
          case 'POST /v1/login/chat/start':
            return out(200, { challenge: 'c'.repeat(24), number: '472', qr: 'dvchat://auth#x', expiresIn: 180 });
          case 'POST /v1/login/chat/status':
            return out(200, stubChatState === 'approved' ? { state: 'approved', subject: String(body.ticket).split('-')[1] } : { state: stubChatState });
          case 'POST /v1/check':
            return body.code === GOOD ? out(200, { ok: true }) : out(401, { error: 'invalid_code', message: 'Неверный код' });
          case 'POST /v1/reset':
            subs.delete(subject);
            return out(200, { ok: true });
          default:
            return out(200, { ok: true, secret: 'SECRETBASE32', uri: 'otpauth://x', recoveryCodes: ['AAAA-BBBB-CCCC'] });
        }
      });
    });
    await new Promise<void>((ok) => stub.listen(0, '127.0.0.1', ok));
    const db = await createTestDb(ADMIN_URL);
    drop = db.drop;
    const cfg = loadConfig({
      DVCLOUD_DATABASE_URL: db.url,
      DVCLOUD_INTERNAL_TOKEN: TOKEN,
      DVCLOUD_COOKIE_SECURE: 'true',
      DVCLOUD_AUTH_URL: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`,
      DVCLOUD_AUTH_SECRET: AUTH_SECRET,
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
    await new Promise((ok) => stub?.close(ok));
    await drop?.();
  });

  it('человек без второго фактора входит сразу; DV Auth получает его id и адрес', async () => {
    const u = await newUser('plain');
    calls.length = 0;
    const r = await login(u);
    assert.equal(r.status, 200);
    assert.ok(r.cookie.startsWith('dvcloud_sid='));
    const begin = calls.find((c) => c.path === '/v1/login/begin');
    assert.equal(begin?.body.subject, u.id);
    assert.match(begin?.body.ip, /127\.0\.0\.1/);
  });

  it('с включённым вторым фактором после пароля сессии нет, только талон', async () => {
    const u = await newUser('anna');
    subs.set(u.id, { enabled: true, totp: false });
    const r = await login(u);
    assert.equal(r.status, 200);
    assert.equal(r.cookie, '');
    assert.equal(r.json.user, undefined);
    assert.ok(r.json.twoFactor.ticket.length >= 20);
    assert.deepEqual(r.json.twoFactor.methods, ['chat', 'totp', 'recovery']);
    assert.equal((await p('GET', '/auth/me')).status, 401);
  });

  it('неверный пароль не доходит до DV Auth', async () => {
    const u = await newUser('boris');
    subs.set(u.id, { enabled: true, totp: false });
    calls.length = 0;
    assert.equal((await p('POST', '/auth/login', { body: { login: 'boris', password: 'wrong-password' } })).status, 401);
    assert.equal(calls.length, 0);
  });

  it('код: неверный отвергается с понятным текстом, верный открывает сессию', async () => {
    const u = await newUser('vera');
    subs.set(u.id, { enabled: true, totp: true });
    const ticket = (await login(u)).json.twoFactor.ticket;
    const bad = await p('POST', '/auth/2fa/code', { body: { ticket, code: '000000' } });
    assert.equal(bad.status, 401);
    assert.equal(bad.json.message, 'Неверный код');
    assert.equal(bad.cookie, '');
    const ok = await p('POST', '/auth/2fa/code', { body: { ticket, code: GOOD } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.user.login, 'vera');
    assert.equal((await p('GET', '/auth/me', { cookie: ok.cookie })).status, 200);
  });

  it('человека отключили между шагами: сессия не открывается', async () => {
    const u = await newUser('gleb');
    subs.set(u.id, { enabled: true, totp: true });
    const ticket = (await login(u)).json.twoFactor.ticket;
    await i('PATCH', '/internal/users/gleb', { body: { disabled: true } });
    const r = await p('POST', '/auth/2fa/code', { body: { ticket, code: GOOD } });
    assert.equal(r.status, 401);
    assert.equal(r.cookie, '');
  });

  it('чат: пока ждём, сессии нет; после подтверждения она открывается', async () => {
    const u = await newUser('dasha');
    subs.set(u.id, { enabled: true, totp: false });
    const ticket = (await login(u)).json.twoFactor.ticket;
    const s = await p('POST', '/auth/2fa/chat/start', { body: { ticket } });
    assert.deepEqual([s.status, s.json.number, s.json.qr.slice(0, 14)], [200, '472', 'dvchat://auth#']);
    stubChatState = 'pending';
    const wait = await p('POST', '/auth/2fa/chat/status', { body: { ticket } });
    assert.deepEqual([wait.json.state, wait.cookie], ['pending', '']);
    stubChatState = 'approved';
    const ok = await p('POST', '/auth/2fa/chat/status', { body: { ticket } });
    assert.equal(ok.json.state, 'approved');
    assert.equal(ok.json.user.login, 'dasha');
    assert.ok(ok.cookie.startsWith('dvcloud_sid='));
    stubChatState = 'pending';
  });

  it('DV Auth не отвечает или секрет не подошёл: вход закрыт (503), а не открыт', async () => {
    const u = await newUser('egor');
    stubDown = true;
    const down = await login(u);
    assert.equal(down.status, 503);
    assert.equal(down.cookie, '');
    stubDown = false;
    stubSecret = 'other-'.padEnd(40, 'z');
    const wrong = await login(u);
    assert.equal(wrong.status, 503);
    assert.equal(wrong.cookie, '');
    assert.ok(!JSON.stringify(wrong.json).includes('секрет'));
    stubSecret = AUTH_SECRET;
    assert.equal((await login(u)).status, 200);
  });

  it('настройки: пароль обязателен, опасные действия требуют код, когда включён TOTP', async () => {
    const u = await newUser('zoya');
    const cookie = (await login(u)).cookie;
    const st = await p('GET', '/auth/security', { cookie });
    assert.equal(st.json.available, true);
    assert.equal((await p('POST', '/auth/security/totp/begin', { cookie, body: { password: 'wrong-password' } })).status, 401);
    calls.length = 0;
    const b = await p('POST', '/auth/security/totp/begin', { cookie, body: { password: u.password } });
    assert.equal(b.status, 200);
    assert.deepEqual(calls.find((c) => c.path === '/v1/totp/begin')?.body, { subject: u.id, label: 'zoya' });
    subs.set(u.id, { enabled: true, totp: true });
    assert.equal((await p('POST', '/auth/security/totp/disable', { cookie, body: { password: u.password } })).status, 401); // без кода
    assert.equal((await p('POST', '/auth/security/totp/disable', { cookie, body: { password: u.password, code: '000000' } })).status, 401);
    assert.equal((await p('POST', '/auth/security/totp/disable', { cookie, body: { password: u.password, code: GOOD } })).status, 200);
    assert.equal((await p('DELETE', '/auth/security/chat', { cookie, body: { password: 'wrong-password' } })).status, 401);
    assert.equal((await p('GET', '/auth/security')).status, 401);
  });

  it('сброс администратором: DV Auth очищен, сессии закрыты, список показывает второй фактор', async () => {
    const u = await newUser('ira');
    const cookie = (await login(u)).cookie;
    subs.set(u.id, { enabled: true, totp: true });
    assert.equal((await i('GET', '/internal/users')).json.users.find((x: any) => x.login === 'ira').twoFactor, true);
    assert.equal((await i('POST', '/internal/users/nobody/reset-2fa')).status, 404);
    calls.length = 0;
    assert.equal((await i('POST', '/internal/users/ira/reset-2fa')).status, 200);
    assert.deepEqual(calls.find((c) => c.path === '/v1/reset')?.body, { subject: u.id });
    assert.equal((await p('GET', '/auth/me', { cookie })).status, 401);
    assert.equal((await i('GET', '/internal/users')).json.users.find((x: any) => x.login === 'ira').twoFactor, false);
  });
});
