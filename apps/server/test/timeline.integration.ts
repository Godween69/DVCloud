import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { startEnv } from './helpers/filesenv';

describe('полоса времени: оглавление по месяцам и старт ленты с месяца (настоящий Postgres)', () => {
  const e = startEnv();
  const { api, upload, jpeg } = e;
  const ids: string[] = [];
  before(async () => {
    await e.start();
    // шесть снимков в разные месяцы; граница месяца проверяется в часовом поясе Москвы
    const dates = ['2026-05-10T12:00:00Z', '2026-03-31T21:30:00Z', '2026-03-15T10:00:00Z', '2025-12-31T22:00:00Z', '2015-03-02T10:00:00Z', '2015-03-01T10:00:00Z'];
    const c = new Client({ connectionString: e.dbUrl });
    await c.connect();
    try {
      for (let i = 0; i < dates.length; i++) {
        const up = await upload(e.anna, `t${i}.jpg`, jpeg(`tl${i}`));
        assert.equal(up.status, 201);
        ids.push(up.json.file.id);
        await c.query('UPDATE files SET taken_at = $1 WHERE id = $2', [dates[i], up.json.file.id]);
      }
      await upload(e.boris, 'b.jpg', jpeg('boris-tl'));
    } finally {
      await c.end();
    }
  });
  after(async () => {
    await e.stop();
  });

  it('оглавление: месяцы от новых к старым, в часовом поясе человека, только свои файлы', async () => {
    const utc = await api('GET', '/api/files/timeline?tz=UTC', { cookie: e.anna });
    assert.equal(utc.status, 200);
    assert.deepEqual(utc.json.months, [{ y: 2026, m: 5, n: 1 }, { y: 2026, m: 3, n: 2 }, { y: 2025, m: 12, n: 1 }, { y: 2015, m: 3, n: 2 }]);
    // Москва (+3): 31 марта 21:30 UTC уже 1 апреля, 31 декабря 22:00 UTC уже 1 января
    const msk = await api('GET', `/api/files/timeline?tz=${encodeURIComponent('Europe/Moscow')}`, { cookie: e.anna });
    assert.deepEqual(msk.json.months, [{ y: 2026, m: 5, n: 1 }, { y: 2026, m: 4, n: 1 }, { y: 2026, m: 3, n: 1 }, { y: 2026, m: 1, n: 1 }, { y: 2015, m: 3, n: 2 }]);
    assert.equal(msk.headers.get('cache-control'), 'no-store');
  });

  it('оглавление: плохой пояс и раздел отвергаются, без входа 401, раздел фильтрует', async () => {
    assert.equal((await api('GET', '/api/files/timeline?tz=Не/Пояс', { cookie: e.anna })).status, 400);
    assert.equal((await api('GET', '/api/files/timeline?kind=x', { cookie: e.anna })).status, 400);
    assert.equal((await api('GET', '/api/files/timeline')).status, 401);
    assert.deepEqual((await api('GET', '/api/files/timeline?kind=videos', { cookie: e.anna })).json.months, []);
    assert.equal((await api('GET', '/api/files/timeline?kind=photos', { cookie: e.anna })).json.months.length, 4);
  });

  it('лента с месяца: начинается с выбранного месяца и идёт вниз, дальше курсор работает как обычно', async () => {
    const r = await api('GET', '/api/files?at=2026-03&tz=UTC&limit=2', { cookie: e.anna });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.files.map((f: { name: string }) => f.name), ['t1.jpg', 't2.jpg']);
    assert.ok(r.json.next);
    const r2 = await api('GET', `/api/files?at=2026-03&tz=UTC&limit=10&before=${encodeURIComponent(r.json.next)}`, { cookie: e.anna });
    assert.deepEqual(r2.json.files.map((f: { name: string }) => f.name), ['t3.jpg', 't4.jpg', 't5.jpg']);
    // тот же месяц в Москве: 31 марта 21:30 UTC уже апрель, поэтому первым идёт мартовский снимок 15-го
    const m = await api('GET', `/api/files?at=2026-03&tz=${encodeURIComponent('Europe/Moscow')}&limit=1`, { cookie: e.anna });
    assert.equal(m.json.files[0].name, 't2.jpg');
    // месяц без снимков: лента идёт с ближайшего более раннего
    const gap = await api('GET', '/api/files?at=2020-06&tz=UTC&limit=1', { cookie: e.anna });
    assert.equal(gap.json.files[0].name, 't4.jpg');
  });

  it('лента вверх: от выбранного месяца можно листать к новым, порядок и границы верные', async () => {
    // начали с марта (в UTC): сверху t1 (31.03), выше него есть t0 (май), значит prev есть
    const r = await api('GET', '/api/files?at=2026-03&tz=UTC&limit=10', { cookie: e.anna });
    assert.deepEqual(r.json.files.map((f: { name: string }) => f.name), ['t1.jpg', 't2.jpg', 't3.jpg', 't4.jpg', 't5.jpg']);
    assert.ok(r.json.prev);
    const up = await api('GET', `/api/files?after=${encodeURIComponent(r.json.prev)}&limit=10`, { cookie: e.anna });
    assert.equal(up.status, 200);
    assert.deepEqual(up.json.files.map((f: { name: string }) => f.name), ['t0.jpg'], 'новее первого: только майский снимок, в обычном порядке');
    assert.equal(up.json.prev, null, 'выше ничего нет');
    // страницами по одному: порядок «новые сверху» сохраняется, prev остаётся, пока есть что догружать
    const first = await api('GET', '/api/files?at=2015-03&tz=UTC&limit=10', { cookie: e.anna });
    assert.deepEqual(first.json.files.map((f: { name: string }) => f.name), ['t4.jpg', 't5.jpg']);
    const p1 = await api('GET', `/api/files?after=${encodeURIComponent(first.json.prev)}&limit=2`, { cookie: e.anna });
    assert.deepEqual(p1.json.files.map((f: { name: string }) => f.name), ['t2.jpg', 't3.jpg']);
    assert.ok(p1.json.prev);
    const p2 = await api('GET', `/api/files?after=${encodeURIComponent(p1.json.prev)}&limit=2`, { cookie: e.anna });
    assert.deepEqual(p2.json.files.map((f: { name: string }) => f.name), ['t0.jpg', 't1.jpg']);
    assert.equal(p2.json.prev, null);
    // обычная первая страница prev не даёт, чужие и плохие значения отвергаются
    assert.equal((await api('GET', '/api/files?limit=2', { cookie: e.anna })).json.prev, null);
    assert.equal((await api('GET', '/api/files?after=мусор', { cookie: e.anna })).status, 400);
    assert.equal((await api('GET', `/api/files?after=${encodeURIComponent(first.json.prev)}&trashed=1`, { cookie: e.anna })).status, 400);
    const bob = await api('GET', `/api/files?after=${encodeURIComponent(first.json.prev)}`, { cookie: e.boris });
    assert.ok(bob.json.files.every((f: { name: string }) => f.name === 'b.jpg'), 'у другого человека только его файлы');
  });

  it('альбом: своё оглавление и лента с месяца, «есть ли новее» считается только внутри альбома', async () => {
    const J = { type: 'application/json' };
    const alb = await api('POST', '/api/albums', { cookie: e.anna, body: JSON.stringify({ name: 'Полоса времени' }), ...J });
    assert.equal(alb.status, 201);
    const id = alb.json.album.id;
    // в альбоме три снимка: 31 марта 2026 (t1), 15 марта 2026 (t2), 2 марта 2015 (t4); майский t0 и остальные не входят
    assert.equal((await api('POST', `/api/albums/${id}/add`, { cookie: e.anna, body: JSON.stringify({ ids: [ids[1], ids[2], ids[4]] }), ...J })).status, 200);
    const tl = await api('GET', `/api/albums/${id}/timeline?tz=UTC`, { cookie: e.anna });
    assert.equal(tl.status, 200);
    assert.deepEqual(tl.json.months, [{ y: 2026, m: 3, n: 2 }, { y: 2015, m: 3, n: 1 }]);
    const old = await api('GET', `/api/albums/${id}/files?at=2015-03&tz=UTC`, { cookie: e.anna });
    assert.deepEqual(old.json.files.map((f: { name: string }) => f.name), ['t4.jpg']);
    assert.ok(old.json.prev, 'в альбоме есть файлы новее');
    const up = await api('GET', `/api/albums/${id}/files?after=${encodeURIComponent(old.json.prev)}`, { cookie: e.anna });
    assert.deepEqual(up.json.files.map((f: { name: string }) => f.name), ['t1.jpg', 't2.jpg']);
    assert.equal(up.json.prev, null, 'новее в альбоме ничего нет, хотя в библиотеке майский t0 есть');
    const top = await api('GET', `/api/albums/${id}/files?at=2026-03&tz=UTC`, { cookie: e.anna });
    assert.equal(top.json.prev, null, 't0 вне альбома и не считается «новее»');
    assert.deepEqual(top.json.files.map((f: { name: string }) => f.name), ['t1.jpg', 't2.jpg', 't4.jpg']);
    // обычная прокрутка вниз по курсору в альбоме тоже работает
    const one = await api('GET', `/api/albums/${id}/files?limit=1`, { cookie: e.anna });
    assert.deepEqual(one.json.files.map((f: { name: string }) => f.name), ['t1.jpg']);
    const two = await api('GET', `/api/albums/${id}/files?limit=1&before=${encodeURIComponent(one.json.next)}`, { cookie: e.anna });
    assert.deepEqual(two.json.files.map((f: { name: string }) => f.name), ['t2.jpg']);
    // чужой альбом недоступен, плохие значения отвергаются
    assert.notEqual((await api('GET', `/api/albums/${id}/timeline?tz=UTC`, { cookie: e.boris })).status, 200);
    assert.equal((await api('GET', `/api/albums/${id}/timeline?tz=Не/Пояс`, { cookie: e.anna })).status, 400);
    assert.equal((await api('GET', `/api/albums/${id}/files?at=2026-13`, { cookie: e.anna })).status, 400);
    assert.equal((await api('GET', '/api/files/timeline?person=x')).status, 401);
    assert.equal((await api('GET', '/api/files/timeline?person=мусор', { cookie: e.anna })).status, 400);
  });

  it('лента с месяца: плохие значения отвергаются', async () => {
    for (const q of ['at=2026-13', 'at=26-3', 'at=2026-03&tz=Nope/Nope', 'at=1900-01']) assert.equal((await api('GET', `/api/files?${q}`, { cookie: e.anna })).status, 400, q);
  });
});
