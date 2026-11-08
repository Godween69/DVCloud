// Общее окружение интеграционных тестов файлов: временная база, временная папка данных, два порта сервера.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApps } from '../../src/bootstrap';
import { loadConfig } from '../../src/config';
import { createTestDb } from './testdb';

const ADMIN_URL: string = process.env.DVCLOUD_TEST_DATABASE_URL ?? '';
if (!ADMIN_URL) throw new Error('Не задан DVCLOUD_TEST_DATABASE_URL: интеграционные тесты без базы не запускаются');
const TOKEN = 'integration-test-token-'.padEnd(40, 'x');

export function startEnv() {
  let drop: () => Promise<void>;
  let dataDir = '';
  let pub: Awaited<ReturnType<typeof createApps>>['pub'];
  let internal: Awaited<ReturnType<typeof createApps>>['internal'];
  let dbUrl = '';
  let base = '';
  let intBase = '';
  let anna = '';
  let boris = '';

  const jpeg = (seed: string, size = 2000) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(seed.repeat(Math.ceil(size / seed.length))).subarray(0, size)]);

  async function intCall(method: string, path: string, body?: unknown) {
    const r = await fetch(intBase + path, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return r.json() as Promise<any>;
  }
  async function loginAs(login: string): Promise<string> {
    const created = await intCall('POST', '/internal/users', { login, displayName: login });
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, password: created.password }) });
    return (r.headers.get('set-cookie') ?? '').split(';')[0];
  }
  async function api(method: string, path: string, o: { cookie?: string; body?: Buffer | string | AsyncIterable<Buffer> | null; type?: string; headers?: Record<string, string>; duplex?: boolean } = {}) {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.cookie) headers.cookie = o.cookie;
    if (o.type) headers['content-type'] = o.type;
    const init: any = { method, headers, body: o.body ?? undefined };
    if (o.duplex) init.duplex = 'half';
    const r = await fetch(base + path, init);
    const buf = Buffer.from(await r.arrayBuffer());
    let json: any = null;
    try {
      json = JSON.parse(buf.toString());
    } catch {
      /* не JSON */
    }
    return { status: r.status, json, buf, headers: r.headers };
  }
  const upload = (cookie: string | undefined, name: string, data: Buffer, modified = '2026-05-10T12:00:00Z') =>
    api('POST', `/api/files?name=${encodeURIComponent(name)}`, { cookie, body: data, type: 'application/octet-stream', headers: { 'x-file-modified': modified } });
  const walk = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(p)));
      else out.push(p);
    }
    return out;
  };

  async function start(extraEnv: Record<string, string> = {}): Promise<void> {
    const db = await createTestDb(ADMIN_URL);
    drop = db.drop;
    dbUrl = db.url;
    dataDir = await mkdtemp(join(tmpdir(), 'dvcloud-data-'));
    const cfg = loadConfig({ DVCLOUD_DATABASE_URL: db.url, DVCLOUD_INTERNAL_TOKEN: TOKEN, DVCLOUD_DATA_DIR: dataDir, DVCLOUD_COOKIE_SECURE: 'true', ...extraEnv });
    ({ pub, internal } = await createApps(cfg, true));
    await pub.listen(0, '127.0.0.1');
    await internal.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(pub.getHttpServer().address() as AddressInfo).port}`;
    intBase = `http://127.0.0.1:${(internal.getHttpServer().address() as AddressInfo).port}`;
    anna = await loginAs('anna');
    boris = await loginAs('boris');
  }
  async function stop(): Promise<void> {
    await pub?.close();
    await internal?.close();
    await drop?.();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }
  return { start, stop, api, upload, intCall, loginAs, jpeg, walk, get dataDir() { return dataDir; }, get dbUrl() { return dbUrl; }, get base() { return base; }, get intBase() { return intBase; }, get token() { return TOKEN; }, get anna() { return anna; }, get boris() { return boris; } };
}
