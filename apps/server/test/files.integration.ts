// Файлы на настоящем Postgres и диске: загрузка, чужие файлы, имена, корзина. Запуск: npm run test:db
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { startEnv } from './helpers/filesenv';

describe('файлы: загрузка, чужие файлы, корзина (настоящий Postgres и диск)', () => {
  const e = startEnv();
  const { api, upload, jpeg, walk } = e;
  before(async () => {
    await e.start();
  });
  after(async () => {
    await e.stop();
  });
  it('без входа и не в том формате загрузка не принимается', async () => {
    assert.equal((await upload(undefined, 'a.jpg', jpeg('a'))).status, 401);
    assert.equal((await api('POST', '/api/files?name=a.jpg', { cookie: e.anna, body: 'x', type: 'text/plain' })).status, 415);
    assert.equal((await api('POST', '/api/files?name=a.jpg', { cookie: e.anna, body: 'a=b', type: 'application/x-www-form-urlencoded' })).status, 415);
    assert.equal((await api('POST', '/api/files', { cookie: e.anna, body: jpeg('a'), type: 'application/octet-stream' })).status, 400);
  });

  it('загрузка кладёт файл по дате снимка, список и скачивание работают, Range работает', async () => {
    const data = jpeg('first');
    const up = await upload(e.anna, 'IMG_1.JPG', data);
    assert.equal(up.status, 201);
    assert.equal(up.json.file.name, 'IMG_1.jpg');
    assert.equal(up.json.file.size, data.length);
    assert.equal(up.json.file.takenAt, '2026-05-10T12:00:00.000Z');
    assert.ok(!JSON.stringify(up.json).includes(e.dataDir), 'путь на диске наружу не отдаётся');
    assert.deepEqual(Buffer.from(await readFile(join(e.dataDir, 'library/anna/2026/05/IMG_1.jpg'))), data);

    const list = await api('GET', '/api/files', { cookie: e.anna });
    assert.equal(list.json.files.length, 1);
    const id = up.json.file.id;

    const dl = await api('GET', `/api/files/${id}`, { cookie: e.anna });
    assert.equal(dl.status, 200);
    assert.deepEqual(dl.buf, data);
    assert.equal(dl.headers.get('content-type'), 'image/jpeg');
    assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
    assert.match(dl.headers.get('content-disposition') ?? '', /^inline;/);

    const part = await api('GET', `/api/files/${id}`, { cookie: e.anna, headers: { range: 'bytes=0-9' } });
    assert.equal(part.status, 206);
    assert.deepEqual(part.buf, data.subarray(0, 10));
    assert.match((await api('GET', `/api/files/${id}?download=1`, { cookie: e.anna })).headers.get('content-disposition') ?? '', /^attachment;/);
  });

  it('тот же файл под другим именем не дублируется, то же имя с другим содержимым получает номер', async () => {
    const again = await upload(e.anna, 'copy-of-first.jpg', jpeg('first'));
    assert.equal(again.status, 200);
    assert.equal(again.json.duplicate, true);
    const other = await upload(e.anna, 'IMG_1.jpg', jpeg('second'));
    assert.equal(other.status, 201);
    assert.equal(other.json.file.name, 'IMG_1.jpg');
    const names = (await readdir(join(e.dataDir, 'library/anna/2026/05'))).sort();
    assert.deepEqual(names, ['IMG_1 (2).jpg', 'IMG_1.jpg']);
  });

  it('параллельная загрузка одного и того же файла даёт одну запись и один файл', async () => {
    const data = jpeg('parallel');
    const rs = await Promise.all([1, 2, 3, 4].map((i) => upload(e.anna, `p${i}.jpg`, data, '2026-06-01T00:00:00Z')));
    assert.equal(rs.filter((r) => r.status === 201).length, 1);
    assert.equal(rs.filter((r) => r.status === 200 && r.json.duplicate).length, 3);
    assert.equal((await readdir(join(e.dataDir, 'library/anna/2026/06'))).length, 1);
  });

  it('чужой человек не видит, не скачивает, не удаляет и не возвращает файлы', async () => {
    const id = (await api('GET', '/api/files', { cookie: e.anna })).json.files[0].id;
    assert.equal((await api('GET', '/api/files', { cookie: e.boris })).json.files.length, 0);
    assert.equal((await api('GET', `/api/files/${id}`, { cookie: e.boris })).status, 404);
    assert.equal((await api('DELETE', `/api/files/${id}`, { cookie: e.boris })).status, 404);
    assert.equal((await api('DELETE', `/api/files/${id}?permanent=1`, { cookie: e.boris })).status, 404);
    assert.equal((await api('POST', `/api/files/${id}/restore`, { cookie: e.boris, body: '{}', type: 'application/json' })).status, 404);
    assert.equal((await api('GET', `/api/files/${id}`, { cookie: e.anna })).status, 200, 'у владельца всё цело');
  });

  it('плохие имена и форматы: путь не выходит за папку, не-медиа отвергается', async () => {
    const r = await upload(e.boris, '../../../evil.jpg', jpeg('evil'));
    assert.equal(r.status, 201);
    assert.equal(r.json.file.name, 'evil.jpg');
    for (const p of await walk(e.dataDir)) assert.ok(p.startsWith(e.dataDir));
    assert.ok((await stat(join(e.dataDir, 'library/boris/2026/05/evil.jpg'))).isFile());
    assert.equal((await upload(e.boris, 'virus.exe', jpeg('v'))).status, 415);
    assert.equal((await upload(e.boris, 'page.html', jpeg('v'))).status, 415);
    assert.equal((await upload(e.boris, 'empty.jpg', Buffer.alloc(0))).status, 400);
    assert.equal((await api('GET', '/api/files/abc', { cookie: e.boris })).status, 404);
    assert.equal((await api('GET', '/api/files/1%2F..%2F..', { cookie: e.boris })).status, 404);
  });

  it('корзина: в корзину, из ленты пропадает, возврат, окончательное удаление только из корзины', async () => {
    const up = await upload(e.boris, 'trash-me.png', jpeg('trashme'), '2026-07-07T07:00:00Z');
    const id = up.json.file.id;
    assert.equal((await api('DELETE', `/api/files/${id}?permanent=1`, { cookie: e.boris })).status, 409, 'сразу насовсем нельзя');

    assert.equal((await api('DELETE', `/api/files/${id}`, { cookie: e.boris })).status, 200);
    assert.equal((await api('DELETE', `/api/files/${id}`, { cookie: e.boris })).status, 409, 'повторно в корзину нельзя');
    assert.ok(!(await api('GET', '/api/files', { cookie: e.boris })).json.files.some((f: any) => f.id === id));
    assert.ok((await api('GET', '/api/files?trashed=1', { cookie: e.boris })).json.files.some((f: any) => f.id === id));
    assert.equal((await api('GET', `/api/files/${id}`, { cookie: e.boris })).status, 404, 'из корзины не отдаётся');
    assert.ok((await readdir(join(e.dataDir, 'trash/boris'))).some((n) => n.startsWith(`${id}-`)));
    await assert.rejects(stat(join(e.dataDir, 'library/boris/2026/07/trash-me.png')));

    assert.equal((await api('POST', `/api/files/${id}/restore`, { cookie: e.boris, body: '{}', type: 'application/json' })).status, 200);
    assert.equal((await api('GET', `/api/files/${id}`, { cookie: e.boris })).status, 200);
    assert.ok((await stat(join(e.dataDir, 'library/boris/2026/07/trash-me.png'))).isFile());

    await api('DELETE', `/api/files/${id}`, { cookie: e.boris });
    assert.equal((await api('DELETE', `/api/files/${id}?permanent=1`, { cookie: e.boris })).status, 200);
    assert.equal((await api('GET', '/api/files?trashed=1', { cookie: e.boris })).json.files.some((f: any) => f.id === id), false);
    assert.equal((await readdir(join(e.dataDir, 'trash/boris'))).some((n) => n.startsWith(`${id}-`)), false);
  });

  it('возврат из корзины, если такой файл уже загружен заново, даёт 409 и ничего не ломает', async () => {
    const data = jpeg('again');
    const first = (await upload(e.boris, 'again.jpg', data, '2026-08-01T00:00:00Z')).json.file.id;
    await api('DELETE', `/api/files/${first}`, { cookie: e.boris });
    assert.equal((await upload(e.boris, 'again2.jpg', data, '2026-08-01T00:00:00Z')).status, 201);
    assert.equal((await api('POST', `/api/files/${first}/restore`, { cookie: e.boris, body: '{}', type: 'application/json' })).status, 409);
    assert.ok((await readdir(join(e.dataDir, 'trash/boris'))).some((n) => n.startsWith(`${first}-`)), 'файл остался в корзине');
  });
});
