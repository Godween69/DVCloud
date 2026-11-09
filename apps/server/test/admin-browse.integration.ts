// Администратор: просмотр файлов всех людей (фильтры, миниатюра, оригинал) и раздача альбомов. Настоящий Postgres и диск.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { startEnv } from './helpers/filesenv';

describe('админ: просмотр всех файлов и раздача альбомов (настоящий Postgres)', () => {
  const e = startEnv();
  const { api, upload, jpeg } = e;
  const ids: Record<string, string> = {};
  const raw = (method: string, path: string, body?: unknown) =>
    fetch(e.intBase + path, { method, headers: { authorization: `Bearer ${e.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const j = async (method: string, path: string, body?: unknown) => { const r = await raw(method, path, body); return { status: r.status, json: await r.json().catch(() => null) as any }; };

  before(async () => {
    await e.start();
    const c = new Client({ connectionString: e.dbUrl });
    await c.connect();
    try {
      const dates: Record<string, string> = { 'a1.jpg': '2026-05-10T12:00:00Z', 'a2.jpg': '2026-03-15T10:00:00Z', 'a3.jpg': '2025-12-31T22:00:00Z', 'b1.jpg': '2026-04-01T09:00:00Z' };
      for (const [name, owner] of [['a1.jpg', e.anna], ['a2.jpg', e.anna], ['a3.jpg', e.anna], ['b1.jpg', e.boris]] as const) {
        const up = await upload(owner, name, jpeg(name));
        assert.equal(up.status, 201);
        ids[name] = up.json.file.id;
        await c.query('UPDATE files SET taken_at = $1 WHERE id = $2', [dates[name], up.json.file.id]);
      }
    } finally { await c.end(); }
  });
  after(async () => { await e.stop(); });

  it('все файлы всех людей, новые сверху, с владельцем и общим числом', async () => {
    const r = await j('GET', '/internal/browse/files');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.files.map((f: any) => `${f.owner}:${f.name}`), ['anna:a1.jpg', 'boris:b1.jpg', 'anna:a2.jpg', 'anna:a3.jpg']);
    assert.equal(r.json.total, 4);
    assert.ok(r.json.files[0].size > 0);
  });

  it('фильтры: человек, даты, часть имени; страницы по курсору', async () => {
    assert.deepEqual((await j('GET', '/internal/browse/files?login=boris')).json.files.map((f: any) => f.name), ['b1.jpg']);
    const march = await j('GET', '/internal/browse/files?from=2026-03-01&to=2026-03-31');
    assert.deepEqual(march.json.files.map((f: any) => f.name), ['a2.jpg']);
    assert.equal(march.json.total, 1);
    assert.deepEqual((await j('GET', '/internal/browse/files?q=A3')).json.files.map((f: any) => f.name), ['a3.jpg'], 'без учёта регистра');
    assert.equal((await j('GET', '/internal/browse/files?q=%25')).json.total, 0, 'знак процента ищется как обычный символ');
    const p1 = await j('GET', '/internal/browse/files?limit=2');
    assert.equal(p1.json.files.length, 2);
    assert.ok(p1.json.next);
    const p2 = await j('GET', `/internal/browse/files?limit=2&before=${encodeURIComponent(p1.json.next)}`);
    assert.deepEqual(p2.json.files.map((f: any) => f.name), ['a2.jpg', 'a3.jpg']);
    assert.equal(p2.json.next, null);
    assert.equal((await j('GET', '/internal/browse/files?from=вчера')).status, 400);
    assert.equal((await j('GET', '/internal/browse/files?limit=0')).status, 400);
    assert.equal((await j('GET', '/internal/browse/files?before=мусор')).status, 400);
  });

  it('файл в корзине не показывается', async () => {
    await api('DELETE', `/api/files/${ids['a3.jpg']}`, { cookie: e.anna });
    const r = await j('GET', '/internal/browse/files');
    assert.equal(r.json.total, 3);
    assert.ok(!r.json.files.some((f: any) => f.name === 'a3.jpg'));
  });

  it('оригинал отдаётся, миниатюры без построенной нет (404), без токена нельзя', async () => {
    const o = await raw('GET', `/internal/browse/files/${ids['b1.jpg']}/original`);
    assert.equal(o.status, 200);
    assert.equal(o.headers.get('content-type'), 'image/jpeg');
    assert.equal(o.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(Buffer.from(await o.arrayBuffer()).length, jpeg('b1.jpg').length);
    assert.equal((await raw('GET', '/internal/browse/files/999999/original')).status, 404);
    assert.equal((await raw('GET', '/internal/browse/files/abc/original')).status, 404);
    const t = await raw('GET', `/internal/browse/files/${ids['b1.jpg']}/thumb`);
    assert.ok(t.status === 200 || t.status === 404);
    assert.equal((await fetch(`${e.intBase}/internal/browse/files`)).status, 401);
  });

  it('раздача альбомов: одному человеку, всем, всё сразу; хозяину делиться нельзя; люди видят то, чем с ними поделились', async () => {
    const J = { type: 'application/json' };
    const alb = (await api('POST', '/api/albums', { cookie: e.anna, body: JSON.stringify({ name: 'Семейный' }), ...J })).json.album;
    await api('POST', `/api/albums/${alb.id}/add`, { cookie: e.anna, body: JSON.stringify({ ids: [ids['a1.jpg']] }), ...J });
    assert.deepEqual((await j('GET', `/internal/albums/${alb.id}/shares`)).json.logins, []);
    assert.equal((await j('PUT', `/internal/albums/${alb.id}/shares/boris`)).status, 200);
    assert.deepEqual((await j('GET', `/internal/albums/${alb.id}/shares`)).json.logins, ['boris']);
    const seen = await api('GET', '/api/albums', { cookie: e.boris });
    assert.ok(seen.json.albums.some((a: any) => a.name === 'Семейный' && a.mine === false), 'Борис видит чужой альбом');
    assert.equal((await j('PUT', `/internal/albums/${alb.id}/shares/anna`)).status, 400, 'хозяину делиться не нужно');
    assert.equal((await j('PUT', `/internal/albums/${alb.id}/shares/nobody`)).status, 404);
    assert.equal((await j('DELETE', `/internal/albums/${alb.id}/shares/boris`)).status, 200);
    assert.deepEqual((await j('GET', `/internal/albums/${alb.id}/shares`)).json.logins, []);
    assert.deepEqual((await j('POST', `/internal/albums/${alb.id}/share-all`, {})).json, { added: 1 });
    assert.deepEqual((await j('POST', `/internal/albums/${alb.id}/share-all`, {})).json, { added: 0 }, 'повтор ничего не добавляет');
    const ba = (await api('POST', '/api/albums', { cookie: e.boris, body: JSON.stringify({ name: 'Борисов' }), ...J })).json.album;
    assert.equal((await j('POST', '/internal/share-everything', {})).status, 400, 'нужно подтверждение');
    const all = await j('POST', '/internal/share-everything', { confirm: true });
    assert.equal(all.status, 200);
    assert.equal(all.json.albums, 2);
    assert.equal(all.json.links, 1, 'добавился только доступ Анны к альбому Бориса, остальное уже было');
    assert.deepEqual((await j('GET', `/internal/albums/${ba.id}/shares`)).json.logins, ['anna']);
    assert.equal((await j('PUT', '/internal/albums/999999/shares/boris')).status, 404);
    // скрыть у всех: доступы сняты, у хозяина альбом остался, человек его больше не видит
    assert.deepEqual((await j('DELETE', `/internal/albums/${alb.id}/shares`)).json, { removed: 1 });
    assert.deepEqual((await j('GET', `/internal/albums/${alb.id}/shares`)).json.logins, []);
    assert.ok(!(await api('GET', '/api/albums', { cookie: e.boris })).json.albums.some((a: any) => a.name === 'Семейный'), 'Борис больше не видит альбом');
    assert.ok((await api('GET', '/api/albums', { cookie: e.anna })).json.albums.some((a: any) => a.name === 'Семейный'), 'у хозяина альбом остался');
    assert.deepEqual((await j('DELETE', `/internal/albums/${alb.id}/shares`)).json, { removed: 0 }, 'повтор ничего не снимает');
    assert.equal((await j('DELETE', '/internal/albums/999999/shares')).status, 404);
    assert.equal((await j('PUT', `/internal/albums/${alb.id}/shares/boris`)).status, 200, 'включить обратно можно');
  });
});
