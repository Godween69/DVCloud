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

  it('одно фото лежит в нескольких альбомах, убрать можно из одного', async () => {
    const c = await api('POST', '/api/albums', { cookie: e.anna, body: body({ name: 'Дача' }), ...J });
    const dacha = c.json.album.id;
    await api('POST', `/api/albums/${dacha}/add`, { cookie: e.anna, body: body({ ids: [a1] }), ...J });
    assert.deepEqual((await api('GET', `/api/albums/of-file/${a1}`, { cookie: e.anna })).json.albums.map((x: any) => x.name), ['Дача', 'Отпуск 2026']);
    const l = await api('GET', '/api/albums', { cookie: e.anna });
    const by = Object.fromEntries(l.json.albums.map((x: any) => [x.name, x.count]));
    assert.deepEqual(by, { 'Дача': 1, 'Отпуск 2026': 2 });
    // повторное добавление ничего не меняет
    const again = await api('POST', `/api/albums/${dacha}/add`, { cookie: e.anna, body: body({ ids: [a1] }), ...J });
    assert.equal(again.json.added, 0);
    // убрать из «Дачи»: в основном альбоме фото остаётся
    const rm = await api('POST', `/api/albums/${dacha}/remove`, { cookie: e.anna, body: body({ ids: [a1, a2] }), ...J });
    assert.equal(rm.json.removed, 1);
    assert.deepEqual((await api('GET', `/api/albums/of-file/${a1}`, { cookie: e.anna })).json.albums.map((x: any) => x.name), ['Отпуск 2026']);
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

  it('список номеров файлов альбома: только свои и не из корзины', async () => {
    const r = await api('GET', `/api/albums/${album}/ids`, { cookie: e.anna });
    assert.equal(r.status, 200);
    assert.deepEqual([...r.json.ids].sort(), [a1, a2].sort());
    await api('DELETE', `/api/files/${a2}`, { cookie: e.anna });
    assert.deepEqual((await api('GET', `/api/albums/${album}/ids`, { cookie: e.anna })).json.ids, [a1]);
    await api('POST', `/api/files/${a2}/restore`, { cookie: e.anna, body: '{}', ...J });
    const bid = (await api('GET', '/api/albums', { cookie: e.boris })).json.albums[0].id;
    assert.equal((await api('GET', `/api/albums/${bid}/ids`, { cookie: e.anna })).status, 404);
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

describe('альбомы по типам и избранные (настоящий Postgres и диск)', () => {
  const e = startEnv();
  const { api, upload, jpeg } = e;
  let photo = '';
  let shot = '';
  let video = '';
  const ids: Record<string, string> = {};
  const mk = async (name: string, kind?: string) => {
    const r = await api('POST', '/api/albums', { cookie: e.anna, body: body(kind === undefined ? { name } : { name, kind }), ...J });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    ids[name] = r.json.album.id;
    return r.json.album;
  };
  before(async () => {
    await e.start();
    photo = (await upload(e.anna, 'p.jpg', jpeg('photo'), '2026-05-01T10:00:00Z')).json.file.id;
    shot = (await upload(e.anna, 's.jpg', jpeg('shot'), '2026-05-02T10:00:00Z')).json.file.id;
    video = (await upload(e.anna, 'v.mp4', Buffer.from('0000ftypmp42' + 'x'.repeat(500)), '2026-05-03T10:00:00Z')).json.file.id;
    assert.equal((await api('POST', '/api/files/kind', { cookie: e.anna, body: body({ kind: 'screenshot', ids: [shot] }), ...J })).status, 200);
  });
  after(async () => { await e.stop(); });

  it('тип задаётся при создании, по умолчанию универсальный, неверный тип отклоняется', async () => {
    assert.equal((await mk('Всё')).kind, 'any');
    assert.equal((await mk('Фотки', 'photos')).kind, 'photos');
    assert.equal((await mk('Ролики', 'videos')).kind, 'videos');
    assert.equal((await mk('Экраны', 'screenshots')).kind, 'screenshots');
    assert.equal((await api('POST', '/api/albums', { cookie: e.anna, body: body({ name: 'Левый', kind: 'music' }), ...J })).status, 400);
    assert.equal((await api('PATCH', `/api/albums/${ids['Экраны']}`, { cookie: e.anna, body: body({ name: 'Экраны', kind: 'photos' }), ...J })).json.album.kind, 'screenshots', 'тип после создания не меняется');
  });

  it('альбом принимает только свой тип, остальное пропускается и считается', async () => {
    const all = [photo, shot, video];
    const add = async (name: string) => (await api('POST', `/api/albums/${ids[name]}/add`, { cookie: e.anna, body: body({ ids: all }), ...J })).json;
    assert.deepEqual(await add('Всё'), { added: 3, rejected: 0 });
    assert.deepEqual(await add('Фотки'), { added: 1, rejected: 2 });
    assert.deepEqual(await add('Ролики'), { added: 1, rejected: 2 });
    assert.deepEqual(await add('Экраны'), { added: 1, rejected: 2 });
    const fid = (name: string) => api('GET', `/api/albums/${ids[name]}/ids`, { cookie: e.anna }).then((r) => r.json.ids);
    assert.deepEqual(await fid('Фотки'), [photo]);
    assert.deepEqual(await fid('Ролики'), [video]);
    assert.deepEqual(await fid('Экраны'), [shot]);
  });

  it('порядок: избранные первыми, потом по типу (универсальные, фото, видео, скриншоты), потом тяжёлые вперёд', async () => {
    const names = async () => (await api('GET', '/api/albums', { cookie: e.anna })).json.albums.map((a: any) => a.name);
    assert.deepEqual(await names(), ['Всё', 'Фотки', 'Ролики', 'Экраны']);
    const f = await api('PATCH', `/api/albums/${ids['Экраны']}/favorite`, { cookie: e.anna, body: body({ favorite: true }), ...J });
    assert.equal(f.status, 200);
    assert.equal(f.json.album.favorite, true);
    assert.deepEqual(await names(), ['Экраны', 'Всё', 'Фотки', 'Ролики']);
    assert.equal((await api('PATCH', `/api/albums/${ids['Экраны']}/favorite`, { cookie: e.anna, body: body({ favorite: 'да' }), ...J })).status, 400);
    assert.equal((await api('PATCH', `/api/albums/${ids['Экраны']}/favorite`, { cookie: e.boris, body: body({ favorite: true }), ...J })).status, 404, 'чужой альбом');
    // среди одного типа тяжёлые вперёд
    const small = await mk('Мало', 'photos');
    const big = await mk('Много', 'photos');
    const extra = (await upload(e.anna, 'p2.jpg', jpeg('photo2'), '2026-05-04T10:00:00Z')).json.file.id;
    await api('POST', `/api/albums/${big.id}/add`, { cookie: e.anna, body: body({ ids: [photo, extra] }), ...J });
    await api('POST', `/api/albums/${small.id}/add`, { cookie: e.anna, body: body({ ids: [photo] }), ...J });
    assert.deepEqual((await names()).filter((n: string) => ['Фотки', 'Мало', 'Много'].includes(n)), ['Много', 'Мало', 'Фотки']); // при равенстве по названию
  });
});
