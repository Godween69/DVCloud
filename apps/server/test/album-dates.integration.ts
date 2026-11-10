import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { startEnv } from './helpers/filesenv';

// Страница «Даты» в админке: массовое исправление дат файлов одного альбома (настоящий Postgres).
describe('даты альбома: сдвиг, одна дата всем, правка по файлам, убрать из альбома', () => {
  const e = startEnv();
  const { api, upload, jpeg } = e;
  const ids: string[] = [];
  let album = '';
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${e.intBase}${path}`, { method, headers: { authorization: `Bearer ${e.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined })
      .then(async (r) => ({ status: r.status, json: (await r.json()) as any }));
  const taken = async () => {
    const c = new Client({ connectionString: e.dbUrl });
    await c.connect();
    try {
      return (await c.query('SELECT id, taken_at, taken_manual FROM files WHERE id = ANY($1) ORDER BY taken_at, id', [ids])).rows as { id: string; taken_at: Date; taken_manual: boolean }[];
    } finally {
      await c.end();
    }
  };

  before(async () => {
    await e.start();
    const c = new Client({ connectionString: e.dbUrl });
    await c.connect();
    try {
      const a = await api('POST', '/api/albums', { cookie: e.anna, body: JSON.stringify({ name: 'Свадьба' }), type: 'application/json' });
      album = a.json.album.id;
      const dates = ['2015-06-28T07:00:00Z', '2015-06-28T07:10:00Z', '2015-06-28T09:00:00Z'];
      for (let i = 0; i < dates.length; i++) {
        const up = await upload(e.anna, `w${i}.jpg`, jpeg(`wedding-date-${i}`));
        assert.equal(up.status, 201);
        ids.push(up.json.file.id);
        await c.query('UPDATE files SET taken_at = $1 WHERE id = $2', [dates[i], up.json.file.id]);
        await c.query('INSERT INTO album_items (album_id, file_id) VALUES ($1, $2)', [album, up.json.file.id]);
      }
    } finally {
      await c.end();
    }
  });
  after(async () => {
    await e.stop();
  });

  it('список: по возрастанию даты, время по поясу из настроек', async () => {
    const r = await call('GET', `/internal/albums/${album}/dates`);
    assert.equal(r.status, 200);
    assert.equal(r.json.total, 3);
    assert.equal(r.json.album.name, 'Свадьба');
    assert.deepEqual(r.json.files.map((f: any) => f.name), ['w0.jpg', 'w1.jpg', 'w2.jpg']);
    const offset = r.json.tz === 'Europe/Moscow' ? 3 : 0;
    assert.equal(r.json.files[0].local, `2015-06-28T${String(7 + offset).padStart(2, '0')}:00:00`);
    assert.equal((await call('GET', '/internal/albums/999999/dates')).status, 404);
  });

  it('сдвиг: первый кадр становится нужным, промежутки сохраняются, даты помечаются ручными', async () => {
    const before = await taken();
    const r = await call('POST', `/internal/albums/${album}/dates`, { mode: 'shift', first: '2019-10-18T14:30' });
    assert.equal(r.status, 200);
    assert.equal(r.json.changed, 3);
    const after = await taken();
    const gap = (a: typeof before) => [a[1].taken_at.getTime() - a[0].taken_at.getTime(), a[2].taken_at.getTime() - a[1].taken_at.getTime()];
    assert.deepEqual(gap(after), gap(before), 'промежутки те же');
    assert.ok(after.every((x) => x.taken_manual));
    const list = await call('GET', `/internal/albums/${album}/dates`);
    assert.equal(list.json.files[0].local, '2019-10-18T14:30:00');
    assert.equal(list.json.files[1].local, '2019-10-18T14:40:00');
    assert.equal(list.json.files[2].local, '2019-10-18T16:30:00');
    // даты из будущего и дикие значения отвергаются, ничего не меняется
    assert.equal((await call('POST', `/internal/albums/${album}/dates`, { mode: 'shift', first: '2999-01-01T10:00' })).status, 400);
    assert.equal((await call('POST', `/internal/albums/${album}/dates`, { mode: 'shift', first: 'вчера' })).status, 400);
    assert.equal((await call('POST', `/internal/albums/${album}/dates`, { mode: 'shift', first: '1980-01-01T10:00' })).status, 400);
    assert.equal((await call('POST', `/internal/albums/${album}/dates`, { mode: 'нет' })).status, 400);
    assert.equal((await call('GET', `/internal/albums/${album}/dates`)).json.files[0].local, '2019-10-18T14:30:00');
  });

  it('по файлам и «всем одну дату»; чужой файл в список не попадёт', async () => {
    const each = await call('POST', `/internal/albums/${album}/dates`, { mode: 'each', items: [{ id: ids[2], at: '2019-10-18T20:00:00' }] });
    assert.equal(each.status, 200);
    assert.equal(each.json.changed, 1);
    assert.equal((await call('GET', `/internal/albums/${album}/dates`)).json.files[2].local, '2019-10-18T20:00:00');
    const other = await upload(e.boris, 'b.jpg', jpeg('boris-not-in-album'));
    assert.equal((await call('POST', `/internal/albums/${album}/dates`, { mode: 'each', items: [{ id: other.json.file.id, at: '2019-10-18T20:00:00' }] })).status, 400);
    assert.equal((await call('POST', `/internal/albums/${album}/dates`, { mode: 'each', items: [] })).status, 400);
    assert.equal((await call('POST', `/internal/albums/${album}/dates`, { mode: 'all', at: '2019-10-18T12:00' })).status, 200);
    assert.deepEqual((await call('GET', `/internal/albums/${album}/dates`)).json.files.map((f: any) => f.local), Array(3).fill('2019-10-18T12:00:00'));
  });

  it('убрать из альбома: файл остаётся в библиотеке владельца', async () => {
    const r = await call('POST', `/internal/albums/${album}/remove-files`, { ids: [ids[0]] });
    assert.equal(r.status, 200);
    assert.equal(r.json.removed, 1);
    assert.equal((await call('GET', `/internal/albums/${album}/dates`)).json.total, 2);
    assert.ok((await api('GET', '/api/files', { cookie: e.anna })).json.files.some((f: any) => f.id === ids[0]), 'файл на месте');
    assert.equal((await call('POST', `/internal/albums/${album}/remove-files`, { ids: [] })).status, 400);
    assert.equal((await call('POST', `/internal/albums/${album}/remove-files`, { ids: ['abc'] })).status, 400);
  });
});
