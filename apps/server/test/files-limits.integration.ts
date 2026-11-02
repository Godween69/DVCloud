// Файлы на настоящем Postgres и диске: листание, квота, обрыв, отключение. Запуск: npm run test:db
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { startEnv } from './helpers/filesenv';

describe('файлы: листание, квота, обрыв (настоящий Postgres и диск)', () => {
  const e = startEnv();
  const { api, upload, jpeg, walk, intCall, loginAs } = e;
  before(async () => {
    await e.start();
  });
  after(async () => {
    await e.stop();
  });
  it('лента листается страницами без повторов и пропусков', async () => {
    for (let i = 0; i < 5; i++) await upload(e.anna, `page${i}.jpg`, jpeg(`page${i}`), `2026-09-0${i + 1}T00:00:00Z`);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r: any = await api('GET', `/api/files?limit=2${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`, { cookie: e.anna });
      seen.push(...r.json.files.map((f: any) => f.id));
      cursor = r.json.next;
    } while (cursor);
    const all = (await api('GET', '/api/files?limit=500', { cookie: e.anna })).json.files.map((f: any) => f.id);
    assert.deepEqual(seen, all);
    assert.equal(new Set(seen).size, seen.length);
    assert.equal((await api('GET', '/api/files?before=мусор', { cookie: e.anna })).status, 400);
    assert.equal((await api('GET', '/api/files?limit=0', { cookie: e.anna })).status, 400);
  });

  it('квота: заранее по Content-Length и на лету при потоковой загрузке; usage считает', async () => {
    const carl = await loginAs('carl');
    const u0 = (await api('GET', '/api/files/usage', { cookie: carl })).json;
    assert.deepEqual(u0, { usedBytes: 0, quotaBytes: null, count: 0 });
    await intCall('PATCH', '/internal/users/carl', { quotaBytes: 3000 });

    assert.equal((await upload(carl, 'big.jpg', jpeg('big', 5000))).status, 413, 'по заголовку размера');

    async function* chunks() {
      for (let i = 0; i < 5; i++) yield jpeg(`s${i}`, 1000);
    }
    const streamed = await api('POST', '/api/files?name=stream.jpg', { cookie: carl, body: ReadableStream.from(chunks()) as any, type: 'application/octet-stream', duplex: true });
    assert.equal(streamed.status, 413, 'на лету без Content-Length');
    assert.ok(!(await walk(join(e.dataDir, 'tmp'))).length, 'недогруженное удалено');

    assert.equal((await upload(carl, 'ok.jpg', jpeg('ok', 2000))).status, 201);
    assert.equal((await upload(carl, 'ok2.jpg', jpeg('ok2', 2000))).status, 413, 'остаток квоты 1000');
    const u = (await api('GET', '/api/files/usage', { cookie: carl })).json;
    assert.equal(u.count, 1);
    assert.equal(u.quotaBytes, 3000);
    assert.ok(u.usedBytes > 2000 && u.usedBytes <= 2003);
  });

  it('отключённый человек теряет доступ к файлам сразу', async () => {
    const dina = await loginAs('dina');
    const id = (await upload(dina, 'd.jpg', jpeg('dina'))).json.file.id;
    await intCall('PATCH', '/internal/users/dina', { disabled: true });
    assert.equal((await api('GET', `/api/files/${id}`, { cookie: dina })).status, 401);
  });

  it('оборванная загрузка не оставляет следов и не ломает сервер', async () => {
    const eve = await loginAs('eve');
    await new Promise<void>((resolve) => {
      const r = httpRequest(
        e.base + '/api/files?name=cut.jpg',
        { method: 'POST', headers: { cookie: eve, 'content-type': 'application/octet-stream', 'content-length': '100000' } },
        () => resolve(),
      );
      r.on('error', () => resolve());
      r.write(jpeg('cut', 5000));
      setTimeout(() => r.destroy(), 150);
    });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(await readdir(join(e.dataDir, 'tmp')), []);
    assert.equal((await api('GET', '/api/files', { cookie: eve })).json.files.length, 0);
    assert.equal((await api('GET', '/api/health')).status, 200);
  });

  it('временная папка после всех загрузок пуста', async () => {
    assert.deepEqual(await readdir(join(e.dataDir, 'tmp')), []);
  });
});
