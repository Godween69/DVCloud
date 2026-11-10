// Роль «Ребёнок», окно «Инфо» с датой, исправление даты админом, «Не знаю» в догадках. Запуск: npm run test:db
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import sharp from 'sharp';
import { startEnv } from './helpers/filesenv';

describe('ребёнок, инфо о файле, дата (настоящий Postgres)', () => {
  const e = startEnv();
  const { api, upload, intCall } = e;
  const jr = (method: string, path: string, cookie: string, body: unknown) => api(method, path, { cookie, body: JSON.stringify(body), type: 'application/json' });
  const db = async (sql: string, params: unknown[] = []) => {
    const c = new Client({ connectionString: e.dbUrl });
    await c.connect();
    try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
  };
  let kid = '';
  let fileId = '';

  before(async () => {
    await e.start({});
    const jpg = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 10, g: 80, b: 160 } } }).jpeg().toBuffer();
    const up = await upload(e.anna, 'IMG_20190615_120000.jpg', jpg);
    assert.equal(up.status, 201);
    fileId = up.json.file.id;
    const made = await intCall('POST', '/internal/users', { login: 'kid', displayName: 'Малыш', isChild: true });
    assert.equal(made.user.isChild, true);
    const r = await fetch(e.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'kid', password: made.password }) });
    kid = (r.headers.get('set-cookie') ?? '').split(';')[0];
  });
  after(async () => { await e.stop(); });

  it('ребёнок: смотреть можно, менять и «взрослые» разделы закрыты сервером', async () => {
    const me = await api('GET', '/api/auth/me', { cookie: kid });
    assert.equal(me.status, 200);
    assert.equal(me.json.user.isChild, true);
    assert.equal((await api('GET', '/api/files', { cookie: kid })).status, 200);
    assert.equal((await api('GET', '/api/albums', { cookie: kid })).status, 200);
    assert.equal((await jr('POST', '/api/albums', kid, { name: 'Мой' })).status, 403, 'альбом создать нельзя');
    assert.equal((await upload(kid, 'x.jpg', Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]))).status, 403, 'загрузка закрыта');
    assert.equal((await api('DELETE', `/api/files/${fileId}`, { cookie: kid })).status, 403, 'удаление закрыто');
    assert.equal((await api('GET', '/api/people', { cookie: kid })).status, 403);
    assert.equal((await api('GET', '/api/search?q=кот', { cookie: kid })).status, 403);
    assert.equal((await api('GET', '/api/albums/suggestions', { cookie: kid })).status, 403);
    assert.equal((await api('GET', '/api/albums/builder/bounds', { cookie: kid })).status, 403);
    assert.equal((await api('GET', '/api/people', { cookie: e.anna })).status, 200, 'взрослому доступно');
  });

  it('галочка снимается и ставится в админке', async () => {
    const on = await intCall('PATCH', '/internal/users/kid', { isChild: false });
    assert.equal(on.user.isChild, false);
    assert.equal((await jr('POST', '/api/albums', kid, { name: 'Мой' })).status, 201);
    assert.equal((await intCall('PATCH', '/internal/users/kid', { isChild: 'да' })).statusCode, 400);
    assert.equal((await intCall('PATCH', '/internal/users/kid', { isChild: true })).user.isChild, true);
  });

  it('«Инфо»: откуда взята дата; админ может исправить, пересчёт дат её не трогает', async () => {
    const info = await api('GET', `/api/files/${fileId}/info`, { cookie: e.anna });
    assert.equal(info.status, 200);
    assert.equal(info.json.name, 'IMG_20190615_120000.jpg');
    assert.equal(info.json.dates.used, 'name');
    assert.ok(info.json.dates.nameDate.startsWith('2019-06-15'));
    assert.equal((await api('GET', `/api/files/${fileId}/info`, { cookie: e.boris })).status, 404, 'чужой файл');
    assert.equal((await intCall('PATCH', `/internal/browse/files/${fileId}/taken`, { takenAt: '1980-01-01T00:00:00Z' })).statusCode, 400);
    const fixed = await intCall('PATCH', `/internal/browse/files/${fileId}/taken`, { takenAt: '2019-06-20T08:30:00Z' });
    assert.equal(fixed.takenAt, '2019-06-20T08:30:00.000Z');
    const after = await api('GET', `/api/files/${fileId}/info`, { cookie: e.anna });
    assert.equal(after.json.dates.used, 'manual');
    assert.ok(after.json.takenAt.startsWith('2019-06-20'));
    assert.equal((await db('SELECT taken_manual FROM files WHERE id = $1', [fileId]))[0].taken_manual, true);
  });

  it('«Не знаю» запоминается для находки', async () => {
    assert.equal((await jr('POST', '/api/people/skip', e.anna, {})).status, 400);
    assert.equal((await jr('POST', '/api/people/skip', e.anna, { detectionId: '999999' })).status, 404);
  });
});
