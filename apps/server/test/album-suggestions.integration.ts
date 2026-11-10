// Предложенные альбомы: события по времени съёмки из файлов, которых нет ни в одном альбоме. Запуск: npm run test:db
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import sharp from 'sharp';
import { startEnv } from './helpers/filesenv';

process.env.DVCLOUD_EVENT_MIN = '4'; // в тесте событием считается серия от 4 снимков

describe('предложенные альбомы (настоящий Postgres)', () => {
  const e = startEnv();
  const { api, upload } = e;
  const jr = (method: string, path: string, cookie: string, body: unknown) => api(method, path, { cookie, body: JSON.stringify(body), type: 'application/json' });
  const pic = (n: number) => sharp({ create: { width: 40, height: 30, channels: 3, background: { r: (n * 7) % 256, g: (n * 13) % 256, b: (n * 29) % 256 } } }).jpeg().toBuffer();
  const db = async (sql: string, params: unknown[] = []) => {
    const c = new Client({ connectionString: e.dbUrl });
    await c.connect();
    try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
  };

  before(async () => {
    await e.start({});
    // 5 снимков 12 июня; по 4 снимка 1 и 2 июля (между днями меньше суток, склеиваются в поездку); 2 снимка 1 августа (мало)
    const plan: [string, number][] = [];
    for (let i = 0; i < 5; i++) plan.push([`2026-06-12T10:${10 + i * 10}:00Z`, i]);
    for (let i = 0; i < 4; i++) plan.push([`2026-07-01T10:${10 + i * 10}:00Z`, 10 + i]);
    for (let i = 0; i < 4; i++) plan.push([`2026-07-02T09:${10 + i * 10}:00Z`, 20 + i]);
    for (let i = 0; i < 2; i++) plan.push([`2026-08-01T10:${10 + i * 10}:00Z`, 30 + i]);
    for (const [at, n] of plan) {
      assert.equal((await upload(e.anna, `p${n}.jpg`, await pic(n))).status, 201);
      await db('UPDATE files SET taken_at = $1 WHERE original_name = $2', [at, `p${n}.jpg`]);
    }
  });
  after(async () => { await e.stop(); });

  it('события находятся по паузам: день и поездка из двух дней, мелочь не считается, свежие первыми', async () => {
    const r = await api('GET', '/api/albums/suggestions', { cookie: e.anna });
    assert.equal(r.status, 200);
    const s = r.json.suggestions as { id: string; name: string; count: number; coverFileId: string; fileIds?: unknown }[];
    assert.deepEqual(s.map((x) => [x.name, x.count]), [['1–2 июля 2026', 8], ['12 июня 2026', 5]]);
    assert.ok(s.every((x) => /^\d+$/.test(x.id) && /^\d+$/.test(x.coverFileId) && x.fileIds === undefined));
    assert.deepEqual((await api('GET', '/api/albums/suggestions', { cookie: e.boris })).json.suggestions, [], 'чужие файлы не предлагаются');
    assert.equal((await api('GET', '/api/albums/suggestions')).status, 401);
  });

  it('«Не нужно» запоминается; принять можно с другим названием; принятое пропадает; повтор отклоняется', async () => {
    const s = (await api('GET', '/api/albums/suggestions', { cookie: e.anna })).json.suggestions as { id: string; name: string }[];
    assert.equal((await jr('POST', '/api/albums/suggestions/dismiss', e.anna, { id: s[0].id })).status, 200);
    assert.equal((await jr('POST', '/api/albums/suggestions/dismiss', e.anna, { id: 'x' })).status, 400);
    assert.deepEqual((await api('GET', '/api/albums/suggestions', { cookie: e.anna })).json.suggestions.map((x: any) => x.name), ['12 июня 2026']);
    // предпросмотр: файлы события; чужой человек его не видит
    const pre = await api('GET', `/api/albums/suggestions/${s[1].id}/files`, { cookie: e.anna });
    assert.equal(pre.status, 200);
    assert.equal(pre.json.files.length, 5);
    assert.equal((await api('GET', `/api/albums/suggestions/${s[1].id}/files`, { cookie: e.boris })).status, 404);
    // убранный при просмотре файл в альбом не попадает
    const ok = await jr('POST', '/api/albums/suggestions/accept', e.anna, { id: s[1].id, name: 'Прогулка', exclude: [pre.json.files[0].id] });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.added, 4);
    assert.equal(ok.json.album.name, 'Прогулка');
    assert.equal(ok.json.album.count, 4);
    assert.deepEqual((await api('GET', '/api/albums/suggestions', { cookie: e.anna })).json.suggestions, [], 'файлы теперь в альбоме');
    assert.equal((await jr('POST', '/api/albums/suggestions/accept', e.anna, { id: s[1].id })).status, 404);
    assert.equal((await jr('POST', '/api/albums/suggestions/accept', e.boris, { id: s[0].id })).status, 404);
  });

  it('название по умолчанию из дат события', async () => {
    const { eventName } = await import('../src/files/albums.service');
    const ms = (iso: string) => new Date(iso).getTime();
    assert.equal(eventName(ms('2026-06-28T09:00:00Z'), ms('2026-07-02T09:00:00Z')), '28 июня – 2 июля 2026');
    assert.equal(eventName(ms('2025-12-31T09:00:00Z'), ms('2026-01-02T09:00:00Z')), '31 декабря 2025 – 2 января 2026');
  });

  it('конструктор альбома: границы дат, подсчёт по датам и источнику, создание, ошибки', async () => {
    const b = (await api('GET', '/api/albums/builder/bounds', { cookie: e.anna })).json;
    assert.equal(b.min, '2026-06-12');
    assert.match(b.max, /^\d{4}-\d{2}-\d{2}$/);
    const count = async (o: unknown) => (await jr('POST', '/api/albums/builder/count', e.anna, o)).json.count;
    assert.equal(await count({ source: 'all' }), 15);
    assert.equal(await count({ source: 'all', from: '2026-07-01', to: '2026-07-01' }), 4, 'один день, обе границы включительно');
    assert.equal(await count({ source: 'all', from: '2026-07-01' }), 10, 'только нижняя граница');
    assert.equal(await count({ source: 'all', to: '2026-06-30' }), 5, 'только верхняя граница');
    const walk = (await api('GET', '/api/albums', { cookie: e.anna })).json.albums.find((a: any) => a.name === 'Прогулка');
    assert.equal(await count({ source: 'albums', albumIds: [walk.id] }), 4, 'источник: выбранный альбом');
    assert.equal(await count({ source: 'albums', albumIds: [walk.id], from: '2026-07-01' }), 0);
    assert.equal(await count({ source: 'videos' }), 0);
    assert.equal((await jr('POST', '/api/albums/builder/count', e.anna, { source: 'all', from: '2026-07-05', to: '2026-07-01' })).status, 400);
    assert.equal((await jr('POST', '/api/albums/builder/count', e.anna, { source: 'all', from: 'вчера' })).status, 400);
    assert.equal((await jr('POST', '/api/albums/builder/count', e.anna, { source: 'albums' })).status, 400, 'нужен хотя бы один альбом');
    assert.equal((await jr('POST', '/api/albums/builder/count', e.anna, { source: 'nonsense' })).status, 400);
    assert.equal((await jr('POST', '/api/albums/builder/count', e.anna, { source: 'all', include: ['999999'] })).status, 404, 'чужого или несуществующего человека нет');
    assert.equal((await jr('POST', '/api/albums/builder/count', e.anna, { source: 'all', include: ['1'], exclude: ['1'] })).status, 400);
    assert.equal(await (async () => (await jr('POST', '/api/albums/builder/count', e.boris, { source: 'all' })).json.count)(), 0, 'чужие файлы не считаются');
    const made = await jr('POST', '/api/albums/builder/create', e.anna, { name: 'Июль', source: 'all', from: '2026-07-01', to: '2026-07-02' });
    assert.equal(made.status, 200);
    assert.equal(made.json.added, 8);
    assert.equal(made.json.album.count, 8);
    assert.equal((await jr('POST', '/api/albums/builder/create', e.anna, { name: 'Июль', source: 'all' })).status, 409, 'название занято');
    assert.equal((await jr('POST', '/api/albums/builder/create', e.anna, { name: 'Пусто', source: 'all', from: '2030-01-01' })).status, 400, 'ничего не подходит');
  });

  it('Del в альбоме: сколько файлов есть и в других альбомах, «из всех альбомов» не трогает библиотеку', async () => {
    const all = await jr('POST', '/api/albums/builder/create', e.anna, { name: 'Всё лето', source: 'all', from: '2026-06-01', to: '2026-08-31' });
    assert.equal(all.json.added, 15);
    const july = (await api('GET', '/api/albums', { cookie: e.anna })).json.albums.find((a: any) => a.name === 'Июль');
    const ids = (await db("SELECT id FROM files WHERE original_name = ANY($1) ORDER BY id", [['p10.jpg', 'p11.jpg']])).map((r) => r.id as string);
    const other = await jr('POST', '/api/albums/in-other', e.anna, { albumId: july.id, fileIds: ids });
    assert.equal(other.status, 200);
    assert.equal(other.json.files, 2);
    assert.ok(other.json.albums.some((a: any) => a.name === 'Всё лето') && other.json.albums.every((a: any) => a.id !== july.id));
    assert.equal((await jr('POST', '/api/albums/in-other', e.boris, { albumId: july.id, fileIds: ids })).status, 404, 'чужой альбом');
    const before = Number((await db("SELECT count(*) AS n FROM album_items ai JOIN files f ON f.id = ai.file_id WHERE f.original_name = ANY($1)", [['p10.jpg', 'p11.jpg']]))[0].n);
    const r = await jr('POST', '/api/albums/remove-everywhere', e.anna, { fileIds: ids });
    assert.equal(r.status, 200);
    assert.equal(r.json.removed, before);
    assert.equal(Number((await db("SELECT count(*) AS n FROM album_items ai JOIN files f ON f.id = ai.file_id WHERE f.original_name = ANY($1)", [['p10.jpg', 'p11.jpg']]))[0].n), 0);
    assert.equal(Number((await db("SELECT count(*) AS n FROM files WHERE original_name = ANY($1) AND trashed_at IS NULL", [['p10.jpg', 'p11.jpg']]))[0].n), 2, 'в корзину не попали');
    assert.equal((await jr('POST', '/api/albums/remove-everywhere', e.boris, { fileIds: ids })).json.removed, 0, 'чужие файлы не трогаются');
    assert.equal((await jr('POST', '/api/albums/remove-everywhere', e.anna, { fileIds: [] })).status, 400);
  });
});
