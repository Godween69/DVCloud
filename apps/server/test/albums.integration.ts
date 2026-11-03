// Альбомы и архивы на настоящем Postgres и диске. Запуск: npm run test:db
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEnv } from './helpers/filesenv';

// unzip есть не везде (на чистой Ubuntu его может не быть): тогда проверяем одним Python.
const HAS_UNZIP = spawnSync('unzip', ['-v']).status === 0;
const J = { type: 'application/json' };
const body = (o: unknown) => JSON.stringify(o);

describe('альбомы (настоящий Postgres и диск)', () => {
  const e = startEnv();
  const { api, upload, jpeg } = e;
  let a1 = '';
  let a2 = '';
  let a3 = '';
  let b1 = '';
  let album = '';
  before(async () => {
    await e.start();
    a1 = (await upload(e.anna, 'one.jpg', jpeg('one'), '2026-05-01T10:00:00Z')).json.file.id;
    a2 = (await upload(e.anna, 'two.jpg', jpeg('two'), '2026-05-02T10:00:00Z')).json.file.id;
    a3 = (await upload(e.anna, 'три.jpg', jpeg('три'), '2026-05-03T10:00:00Z')).json.file.id;
    b1 = (await upload(e.boris, 'boris.jpg', jpeg('boris'))).json.file.id;
  });
  after(async () => {
    await e.stop();
  });

  it('без входа и без JSON ничего не работает', async () => {
    assert.equal((await api('GET', '/api/albums')).status, 401);
    assert.equal((await api('GET', '/api/zip?ids=1')).status, 401);
    const r = await api('POST', '/api/albums', { cookie: e.anna, body: 'name=x', type: 'application/x-www-form-urlencoded' });
    assert.equal(r.status, 415);
  });

  it('создание, имя без учёта регистра уникально, пустое имя нельзя', async () => {
    const c = await api('POST', '/api/albums', { cookie: e.anna, body: body({ name: '  Отпуск   2026 ' }), ...J });
    assert.equal(c.status, 201);
    assert.equal(c.json.album.name, 'Отпуск 2026');
    assert.equal(c.json.album.count, 0);
    assert.equal(c.json.album.coverFileId, null);
    album = c.json.album.id;
    assert.equal((await api('POST', '/api/albums', { cookie: e.anna, body: body({ name: 'отпуск 2026' }), ...J })).status, 409);
    assert.equal((await api('POST', '/api/albums', { cookie: e.anna, body: body({ name: '   ' }), ...J })).status, 400);
    assert.equal((await api('POST', '/api/albums', { cookie: e.anna, body: body({ name: 'x'.repeat(101) }), ...J })).status, 400);
    // у другого человека такое же имя можно
    assert.equal((await api('POST', '/api/albums', { cookie: e.boris, body: body({ name: 'Отпуск 2026' }), ...J })).status, 201);
  });

  it('добавление: чужие и несуществующие файлы молча пропускаются, повтор не плодит записи', async () => {
    const r = await api('POST', `/api/albums/${album}/add`, { cookie: e.anna, body: body({ ids: [a1, a2, b1, '999999'] }), ...J });
    assert.equal(r.status, 200);
    assert.equal(r.json.added, 2);
    await api('POST', `/api/albums/${album}/add`, { cookie: e.anna, body: body({ ids: [a1] }), ...J });
    const l = await api('GET', '/api/albums', { cookie: e.anna });
    assert.equal(l.json.albums.length, 1);
    assert.equal(l.json.albums[0].count, 2);
    assert.equal(l.json.albums[0].coverFileId, a2); // обложка: самое свежее фото
    assert.equal((await api('POST', `/api/albums/${album}/add`, { cookie: e.anna, body: body({ ids: [] }), ...J })).status, 400);
    assert.equal((await api('POST', `/api/albums/${album}/add`, { cookie: e.anna, body: body({ ids: ['abc'] }), ...J })).status, 400);
  });

  it('чужой альбом неотличим от несуществующего', async () => {
    const bl = await api('GET', '/api/albums', { cookie: e.boris });
    const bid = bl.json.albums[0].id;
    for (const [m, p, b] of [
      ['GET', `/api/albums/${bid}/files`, undefined],
      ['GET', `/api/albums/${bid}/zip`, undefined],
      ['PATCH', `/api/albums/${bid}`, body({ name: 'взлом' })],
      ['DELETE', `/api/albums/${bid}`, undefined],
      ['POST', `/api/albums/${bid}/add`, body({ ids: [a1] })],
      ['GET', `/api/albums/777777/files`, undefined],
    ] as const) {
      const r = await api(m, p, { cookie: e.anna, body: b, ...(b ? J : {}) });
      assert.equal(r.status, 404, `${m} ${p}`);
    }
    assert.equal((await api('GET', `/api/albums/of-file/${b1}`, { cookie: e.anna })).status, 404);
    assert.equal((await api('GET', '/api/albums', { cookie: e.boris })).json.albums[0].count, 0);
  });

  it('лента альбома и в каком альбоме файл', async () => {
    const f = await api('GET', `/api/albums/${album}/files?limit=1`, { cookie: e.anna });
    assert.equal(f.status, 200);
    assert.deepEqual(f.json.files.map((x: any) => x.id), [a2]);
    assert.ok(f.json.next);
    const f2 = await api('GET', `/api/albums/${album}/files?limit=1&before=${encodeURIComponent(f.json.next)}`, { cookie: e.anna });
    assert.deepEqual(f2.json.files.map((x: any) => x.id), [a1]);
    assert.equal(f2.json.next, null);
    assert.equal((await api('GET', `/api/albums/of-file/${a1}`, { cookie: e.anna })).json.album.id, album);
    assert.equal((await api('GET', `/api/albums/of-file/${a3}`, { cookie: e.anna })).json.album, null);
  });

  it('«Сменить альбом»: файл переезжает, в двух альбомах не лежит', async () => {
    const c = await api('POST', '/api/albums', { cookie: e.anna, body: body({ name: 'Дача' }), ...J });
    const dacha = c.json.album.id;
    await api('POST', `/api/albums/${dacha}/add`, { cookie: e.anna, body: body({ ids: [a1] }), ...J });
    assert.equal((await api('GET', `/api/albums/of-file/${a1}`, { cookie: e.anna })).json.album.name, 'Дача');
    const l = await api('GET', '/api/albums', { cookie: e.anna });
    const by = Object.fromEntries(l.json.albums.map((x: any) => [x.name, x.count]));
    assert.deepEqual(by, { 'Дача': 1, 'Отпуск 2026': 1 });
    // убрать из альбома
    const rm = await api('POST', `/api/albums/${dacha}/remove`, { cookie: e.anna, body: body({ ids: [a1, a2] }), ...J });
    assert.equal(rm.json.removed, 1);
    assert.equal((await api('GET', `/api/albums/of-file/${a1}`, { cookie: e.anna })).json.album, null);
    await api('POST', `/api/albums/${album}/add`, { cookie: e.anna, body: body({ ids: [a1] }), ...J });
  });

  it('переименование и конфликт имён', async () => {
    const ok = await api('PATCH', `/api/albums/${album}`, { cookie: e.anna, body: body({ name: 'Море' }), ...J });
    assert.equal(ok.json.album.name, 'Море');
    assert.equal((await api('PATCH', `/api/albums/${album}`, { cookie: e.anna, body: body({ name: 'дача' }), ...J })).status, 409);
  });

  it('файл в корзине пропадает из альбома, после восстановления возвращается', async () => {
    await api('DELETE', `/api/files/${a2}`, { cookie: e.anna });
    const l = await api('GET', '/api/albums', { cookie: e.anna });
    assert.equal(l.json.albums.find((x: any) => x.name === 'Море').count, 1);
    assert.deepEqual((await api('GET', `/api/albums/${album}/files`, { cookie: e.anna })).json.files.map((x: any) => x.id), [a1]);
    await api('POST', `/api/files/${a2}/restore`, { cookie: e.anna, body: '{}', ...J });
    assert.equal((await api('GET', '/api/albums', { cookie: e.anna })).json.albums.find((x: any) => x.name === 'Море').count, 2);
  });

  function check(buf: Buffer, names: string[]): void {
    const dir = mkdtempSync(join(tmpdir(), 'alb-'));
    try {
      const f = join(dir, 'a.zip');
      writeFileSync(f, buf);
      if (HAS_UNZIP) {
        const un = spawnSync('unzip', ['-tq', f], { encoding: 'utf8' });
        assert.equal(un.status, 0, un.stdout + un.stderr);
      }
      const py = spawnSync('python3', ['-I', '-c', 'import sys,zipfile,json;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(json.dumps(z.namelist(),ensure_ascii=False))', f], { encoding: 'utf8' });
      assert.equal(py.status, 0, py.stderr);
      assert.deepEqual(JSON.parse(py.stdout), names);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('скачивание альбома целиком: настоящий ZIP с нужными файлами', async () => {
    const r = await api('GET', `/api/albums/${album}/zip`, { cookie: e.anna });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/zip');
    assert.equal(Number(r.headers.get('content-length')), r.buf.length);
    assert.match(r.headers.get('content-disposition') ?? '', /attachment; filename=.*UTF-8''%D0%9C%D0%BE%D1%80%D0%B5\.zip/);
    check(r.buf, ['one.jpg', 'two.jpg']);
  });

  it('скачивание подборки: свои файлы, одинаковые имена получают номер, чужие игнорируются', async () => {
    const dup = (await upload(e.anna, 'one.jpg', jpeg('другое содержимое'), '2026-05-04T10:00:00Z')).json.file.id;
    const r = await api('GET', `/api/zip?ids=${a3},${a1},${dup},${b1}&name=${encodeURIComponent('Выбор/1')}`, { cookie: e.anna });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition') ?? '', /Выбор_1\.zip|%D0%92%D1%8B%D0%B1%D0%BE%D1%80_1\.zip/);
    check(r.buf, ['one.jpg', 'три.jpg', 'one (2).jpg']);
    assert.equal((await api('GET', `/api/zip?ids=${b1}`, { cookie: e.anna })).status, 404);
    assert.equal((await api('GET', '/api/zip', { cookie: e.anna })).status, 400);
    assert.equal((await api('GET', '/api/zip?ids=1,abc', { cookie: e.anna })).status, 400);
  });

  it('удаление альбома не трогает фото', async () => {
    assert.equal((await api('DELETE', `/api/albums/${album}`, { cookie: e.anna })).status, 200);
    assert.equal((await api('GET', `/api/files/${a1}`, { cookie: e.anna })).status, 200);
    assert.equal((await api('GET', `/api/albums/of-file/${a1}`, { cookie: e.anna })).json.album, null);
    assert.equal((await api('GET', `/api/albums/${album}/files`, { cookie: e.anna })).status, 404);
  });

  it('окончательное удаление файла убирает его из альбома без ошибок', async () => {
    const c = await api('POST', '/api/albums', { cookie: e.anna, body: body({ name: 'Временный' }), ...J });
    const id = c.json.album.id;
    await api('POST', `/api/albums/${id}/add`, { cookie: e.anna, body: body({ ids: [a3] }), ...J });
    await api('DELETE', `/api/files/${a3}`, { cookie: e.anna });
    assert.equal((await api('DELETE', `/api/files/${a3}?permanent=1`, { cookie: e.anna })).status, 200);
    assert.equal((await api('GET', '/api/albums', { cookie: e.anna })).json.albums.find((x: any) => x.name === 'Временный').count, 0);
  });
});
