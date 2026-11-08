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

  it('лента с месяца: плохие значения отвергаются', async () => {
    for (const q of ['at=2026-13', 'at=26-3', 'at=2026-03&tz=Nope/Nope', 'at=1900-01']) assert.equal((await api('GET', `/api/files?${q}`, { cookie: e.anna })).status, 400, q);
  });
});
