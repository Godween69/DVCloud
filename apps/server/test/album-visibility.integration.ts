// Допуски альбомов (где показывать), удаление альбома «в скрытые», откуда взялись файлы без владельца.
// Настоящий Postgres и диск. Запуск: npm run test:db
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv } from './helpers/filesenv';

const J = { type: 'application/json' };
const body = (o: unknown) => JSON.stringify(o);

describe('альбомы: допуски, удалённые, происхождение файлов', () => {
  const e = startEnv();
  const { api, upload, jpeg } = e;
  // Внутренний API админки: статус и тело ответа.
  const intCall = async (method: string, path: string, data?: unknown) => {
    const r = await fetch(e.intBase + path, { method, headers: { authorization: `Bearer ${e.token}`, ...(data !== undefined ? { 'content-type': 'application/json' } : {}) }, body: data !== undefined ? JSON.stringify(data) : undefined });
    let json: any = null;
    try { json = await r.json(); } catch { /* пустой ответ */ }
    return { status: r.status, json };
  };
  let sec = ''; // фото в скрытом альбоме
  let open = ''; // обычное фото
  let both = ''; // лежит и в скрытом, и в обычном альбоме
  let vid = ''; // видео в альбоме
  let secAlbum = '';
  let openAlbum = '';
  const ids = async (path: string) => (await api('GET', path, { cookie: e.anna })).json.files.map((f: any) => f.id);

  before(async () => {
    await e.start();
    sec = (await upload(e.anna, 'secret.jpg', jpeg('secret'), '2026-05-01T10:00:00Z')).json.file.id;
    open = (await upload(e.anna, 'open.jpg', jpeg('open'), '2026-05-02T10:00:00Z')).json.file.id;
    both = (await upload(e.anna, 'both.jpg', jpeg('both'), '2026-05-03T10:00:00Z')).json.file.id;
    vid = (await upload(e.anna, 'clip.mp4', Buffer.from('0000ftypmp42' + 'v'.repeat(300)), '2026-05-04T10:00:00Z')).json.file.id;
    secAlbum = (await api('POST', '/api/albums', { cookie: e.anna, body: body({ name: 'Личное' }), ...J })).json.album.id;
    openAlbum = (await api('POST', '/api/albums', { cookie: e.anna, body: body({ name: 'Открытый' }), ...J })).json.album.id;
    await api('POST', `/api/albums/${secAlbum}/add`, { cookie: e.anna, body: body({ ids: [sec, both, vid] }), ...J });
    await api('POST', `/api/albums/${openAlbum}/add`, { cookie: e.anna, body: body({ ids: [both] }), ...J });
  });
  after(async () => {
    await e.stop();
  });

  it('по умолчанию альбом показывается везде', async () => {
    const a = (await api('GET', '/api/albums', { cookie: e.anna })).json.albums.find((x: any) => x.id === secAlbum);
    assert.deepEqual(a.show, { library: true, photos: true, videos: true, screenshots: true });
    const lib = await ids('/api/files');
    for (const id of [sec, open, both, vid]) assert.ok(lib.includes(id));
  });

  it('допуск «Библиотека» выключен: файлы пропали из библиотеки, но видны внутри альбома; фото остаются в «Фото»', async () => {
    const r = await api('PATCH', `/api/albums/${secAlbum}/show`, { cookie: e.anna, body: body({ library: false }), ...J });
    assert.equal(r.status, 200);
    assert.equal(r.json.album.show.library, false);
    assert.equal(r.json.album.show.photos, true);
    const lib = await ids('/api/files');
    assert.ok(!lib.includes(sec) && !lib.includes(both) && !lib.includes(vid), 'скрытые из библиотеки');
    assert.ok(lib.includes(open));
    const photos = await ids('/api/files?kind=photos');
    assert.ok(photos.includes(sec), 'в «Фото» файл всё ещё виден: допуски независимы');
    const inAlbum = (await api('GET', `/api/albums/${secAlbum}/files`, { cookie: e.anna })).json.files.map((f: any) => f.id);
    assert.deepEqual([...inAlbum].sort(), [sec, both, vid].sort(), 'внутри альбома видно всё');
  });

  it('допуски по разделам независимы: убрали из «Фото» и «Видео»', async () => {
    await api('PATCH', `/api/albums/${secAlbum}/show`, { cookie: e.anna, body: body({ library: true, photos: false, videos: false }), ...J });
    assert.ok((await ids('/api/files')).includes(sec), 'библиотека снова показывает');
    assert.ok(!(await ids('/api/files?kind=photos')).includes(sec));
    assert.ok(!(await ids('/api/files?kind=videos')).includes(vid));
    // оглавление ленты тоже считает без скрытого: нет «призраков» на полосе дат
    const tl = (await api('GET', '/api/files/timeline?kind=photos&tz=UTC', { cookie: e.anna })).json;
    const total = (tl.months ?? tl).reduce((n: number, m: any) => n + m.n, 0);
    assert.equal(total, (await ids('/api/files?kind=photos')).length);
  });

  it('файл, который лежит и в скрытом альбоме, и в открытом, всё равно скрыт (так надёжнее для личных фото)', async () => {
    await api('PATCH', `/api/albums/${secAlbum}/show`, { cookie: e.anna, body: body({ library: false, photos: true, videos: true }), ...J });
    assert.ok(!(await ids('/api/files')).includes(both));
  });

  it('чужие допуски не меняются; неверные поля отклоняются', async () => {
    assert.equal((await api('PATCH', `/api/albums/${secAlbum}/show`, { cookie: e.boris, body: body({ library: true }), ...J })).status, 404);
    assert.equal((await api('PATCH', `/api/albums/${secAlbum}/show`, { cookie: e.anna, body: body({ library: 'нет' }), ...J })).status, 400);
    assert.equal((await api('PATCH', `/api/albums/${secAlbum}/show`, { cookie: e.anna, body: body({}), ...J })).status, 400);
    assert.equal((await api('PATCH', `/api/albums/${secAlbum}/show`, { cookie: e.anna, body: body({ library: true }) })).status, 415);
  });

  it('удаление альбома: у человека пропал, админ видит его среди удалённых, фото на месте и снова видны в ленте', async () => {
    assert.equal((await api('DELETE', `/api/albums/${secAlbum}`, { cookie: e.anna })).status, 200);
    assert.ok(!(await api('GET', '/api/albums', { cookie: e.anna })).json.albums.some((x: any) => x.id === secAlbum));
    assert.equal((await api('GET', `/api/albums/${secAlbum}/files`, { cookie: e.anna })).status, 404);
    assert.ok((await ids('/api/files')).includes(sec), 'допуск удалённого альбома больше не прячет файлы');
    const del = (await intCall('GET', '/internal/albums-deleted')).json.albums;
    const mine = del.find((x: any) => x.id === secAlbum);
    assert.ok(mine, 'в списке удалённых');
    assert.equal(mine.name, 'Личное');
    assert.equal(mine.owner, 'anna');
    assert.equal(mine.count, 3);
    assert.ok(!(await intCall('GET', '/internal/albums')).json.albums.some((x: any) => x.id === secAlbum), 'в обычном списке админа его нет');
  });

  it('имя удалённого альбома освобождается; возврат при занятом имени идёт под другим названием', async () => {
    const again = await api('POST', '/api/albums', { cookie: e.anna, body: body({ name: 'личное' }), ...J });
    assert.equal(again.status, 201, 'то же название можно занять заново');
    const r = await intCall('POST', `/internal/albums/${secAlbum}/restore`, {});
    assert.equal(r.status, 200);
    assert.equal(r.json.name, 'Личное (2)');
    assert.ok((await api('GET', '/api/albums', { cookie: e.anna })).json.albums.some((x: any) => x.id === secAlbum && x.name === 'Личное (2)'));
    assert.equal((await intCall('POST', `/internal/albums/${secAlbum}/restore`, {})).status, 404, 'уже не удалён');
  });

  it('стереть удалённый альбом насовсем можно, живой так не стирается', async () => {
    const tmp = (await api('POST', '/api/albums', { cookie: e.anna, body: body({ name: 'Временный' }), ...J })).json.album.id;
    assert.equal((await intCall('DELETE', `/internal/albums-deleted/${tmp}`)).status, 404, 'живой альбом этой кнопкой не стереть');
    await api('DELETE', `/api/albums/${tmp}`, { cookie: e.anna });
    assert.equal((await intCall('DELETE', `/internal/albums-deleted/${tmp}`)).status, 200);
    assert.ok(!(await intCall('GET', '/internal/albums-deleted')).json.albums.some((x: any) => x.id === tmp));
  });

  it('бесхозный файл помнит, кто и откуда его убрал', async () => {
    const f = (await upload(e.anna, 'remember.jpg', jpeg('remember'), '2026-06-01T10:00:00Z')).json.file.id;
    await api('POST', `/api/albums/${openAlbum}/add`, { cookie: e.anna, body: body({ ids: [f] }), ...J });
    await api('DELETE', `/api/files/${f}`, { cookie: e.anna });
    assert.equal((await api('DELETE', `/api/files/${f}?permanent=1`, { cookie: e.anna })).status, 200);
    const orph = (await intCall('GET', '/internal/files/orphans')).json.orphans;
    const o = orph.find((x: any) => x.note && x.note.includes('Открытый'));
    assert.ok(o, 'есть бесхозный файл с пометкой об альбоме');
    assert.match(o.note, /Убрал насовсем из корзины: anna/);
    assert.match(o.note, /Был в альбомах: Открытый/);
    assert.ok(o.orphanedAt);
  });
});
