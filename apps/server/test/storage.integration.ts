// Единое хранение, заявка по хешу, докачка, общий доступ и действия администратора. Настоящий Postgres и диск. Запуск: npm run test:db
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { startEnv } from './helpers/filesenv';

const J = { type: 'application/json' };
const body = (o: unknown) => JSON.stringify(o);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('единое хранение и общий доступ (настоящий Postgres и диск)', () => {
  const e = startEnv();
  const { api, upload, jpeg, intCall } = e;
  const libraryFiles = async () => (await e.walk(join(e.dataDir, 'library'))).filter((p) => !p.endsWith('.tmp'));
  before(async () => {
    await e.start();
  });
  after(async () => {
    await e.stop();
  });

  it('одно содержимое у двух людей лежит на диске один раз', async () => {
    const data = jpeg('shared-photo', 3000);
    const a = await upload(e.anna, 'IMG_1.jpg', data, '2026-05-10T10:00:00Z');
    assert.equal(a.status, 201);
    const before = (await libraryFiles()).length;
    const b = await upload(e.boris, 'другое имя.jpg', data, '2026-05-11T10:00:00Z');
    assert.equal(b.status, 201, 'у Бориса появилась своя запись');
    assert.notEqual(b.json.file.id, a.json.file.id);
    assert.equal(b.json.file.name, 'другое имя.jpg');
    assert.equal((await libraryFiles()).length, before, 'второй копии на диске нет');
    // оба файла открываются своим владельцем
    assert.equal((await api('GET', `/api/files/${a.json.file.id}`, { cookie: e.anna })).buf.equals(data), true);
    assert.equal((await api('GET', `/api/files/${b.json.file.id}`, { cookie: e.boris })).buf.equals(data), true);
    // чужую запись Борис по номеру Анны не откроет
    assert.equal((await api('GET', `/api/files/${a.json.file.id}`, { cookie: e.boris })).status, 404);
    // повтор у того же человека остаётся дубликатом
    assert.equal((await upload(e.boris, 'ещё раз.jpg', data)).status, 200);
  });

  it('заявка по хешу: файл уже в облаке, загружать нечего', async () => {
    const data = jpeg('claim-me', 2500);
    const h = sha(data);
    const a = await upload(e.anna, 'claim.jpg', data, '2026-06-01T10:00:00Z');
    const items = [{ sha256: h, name: 'мой.jpg', modified: '2026-06-02T10:00:00Z' }, { sha256: sha(jpeg('нет такого')), name: 'x.jpg' }, { sha256: 'zzz', name: 'x.jpg' }];
    const r = await api('POST', '/api/files/claim', { cookie: e.boris, body: body({ items }), ...J });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.results.map((x: any) => x.state), ['linked', 'unknown', 'bad']);
    assert.equal(r.json.results[0].file.name, 'мой.jpg');
    assert.notEqual(r.json.results[0].file.id, a.json.file.id);
    // повтор: уже моё
    assert.equal((await api('POST', '/api/files/claim', { cookie: e.boris, body: body({ items: [items[0]] }), ...J })).json.results[0].state, 'mine');
    // скрыл и заявил снова: запись оживает
    const id = r.json.results[0].file.id;
    await api('DELETE', `/api/files/${id}`, { cookie: e.boris });
    const again = await api('POST', '/api/files/claim', { cookie: e.boris, body: body({ items: [items[0]] }), ...J });
    assert.equal(again.json.results[0].state, 'restored');
    assert.equal(again.json.results[0].file.id, id);
    // без JSON и без входа нельзя
    assert.equal((await api('POST', '/api/files/claim', { cookie: e.boris, body: 'x', type: 'text/plain' })).status, 415);
    assert.equal((await api('POST', '/api/files/claim', { body: body({ items }), ...J })).status, 401);
    assert.equal((await api('POST', '/api/files/claim', { cookie: e.boris, body: body({ items: [] }), ...J })).status, 400);
  });

  it('квота: заявка по хешу не пускает сверх остатка, оценка и просьба о месте работают', async () => {
    const data = jpeg('quota-big', 5000);
    await upload(e.anna, 'q.jpg', data);
    const who = (await api('GET', '/api/auth/me', { cookie: e.boris })).json.user.login;
    assert.equal(who, 'boris');
    const used = (await api('GET', '/api/files/usage', { cookie: e.boris })).json.usedBytes;
    await intCall('PATCH', '/internal/users/boris', { quotaBytes: used + 100 });
    const est = await api('POST', '/api/files/estimate', { cookie: e.boris, body: body({ bytes: 5000 }), ...J });
    assert.equal(est.json.fits, false);
    assert.equal(est.json.freeBytes, 100);
    assert.equal((await api('POST', '/api/files/estimate', { cookie: e.boris, body: body({ bytes: 50 }), ...J })).json.fits, true);
    const r = await api('POST', '/api/files/claim', { cookie: e.boris, body: body({ items: [{ sha256: sha(data), name: 'q.jpg' }] }), ...J });
    assert.equal(r.json.results[0].state, 'quota');
    assert.equal((await upload(e.boris, 'big.jpg', data)).status, 413);
    // просьба о месте видна администратору
    assert.equal((await api('POST', '/api/files/quota-request', { cookie: e.boris, body: body({ needBytes: 5000, note: 'отпуск' }), ...J })).status, 200);
    const list = await intCall('GET', '/internal/quota-requests');
    assert.equal(list.requests.length, 1);
    assert.equal(list.requests[0].login, 'boris');
    assert.equal(list.requests[0].needBytes, 5000);
    await intCall('POST', `/internal/quota-requests/${list.requests[0].id}/resolve`);
    assert.equal((await intCall('GET', '/internal/quota-requests')).requests.length, 0);
    await intCall('PATCH', '/internal/users/boris', { quotaBytes: null });
  });

  it('загрузка по частям: докачка после обрыва, неверное смещение, повторный запуск находит сессию', async () => {
    const data = jpeg('resumable-file', 30000);
    const start = await api('POST', '/api/uploads', { cookie: e.anna, body: body({ name: 'big.jpg', size: data.length, modified: '2026-07-01T10:00:00Z' }), ...J });
    assert.equal(start.status, 200);
    const id = start.json.id;
    assert.equal(start.json.offset, 0);
    const patch = (offset: number, chunk: Buffer) => api('PATCH', `/api/uploads/${id}`, { cookie: e.anna, body: chunk, type: 'application/octet-stream', headers: { 'upload-offset': String(offset) } });
    const p1 = await patch(0, data.subarray(0, 10000));
    assert.equal(p1.json.offset, 10000);
    assert.equal(p1.json.done, false);
    // неверное смещение: 409 и настоящее значение
    const bad = await patch(5000, data.subarray(5000, 9000));
    assert.equal(bad.status, 409);
    assert.equal(bad.json.offset, 10000);
    // «обрыв»: клиент спрашивает, сколько принято, и продолжает
    assert.equal((await api('GET', `/api/uploads/${id}`, { cookie: e.anna })).json.offset, 10000);
    // та же сессия находится по имени, размеру и дате
    const same = await api('POST', '/api/uploads', { cookie: e.anna, body: body({ name: 'big.jpg', size: data.length, modified: '2026-07-01T10:00:00Z' }), ...J });
    assert.equal(same.json.id, id);
    assert.equal(same.json.offset, 10000);
    // чужой человек сессию не видит
    assert.equal((await api('GET', `/api/uploads/${id}`, { cookie: e.boris })).status, 404);
    assert.equal((await patch(10000, data.subarray(10000, 20000))).json.offset, 20000);
    const last = await patch(20000, data.subarray(20000));
    assert.equal(last.json.done, true);
    assert.equal(last.json.file.sha256, sha(data));
    assert.equal(last.json.file.name, 'big.jpg');
    assert.equal((await api('GET', `/api/files/${last.json.file.id}`, { cookie: e.anna })).buf.equals(data), true);
    // сессия закрыта
    assert.equal((await api('GET', `/api/uploads/${id}`, { cookie: e.anna })).status, 404);
    // лишнего не принимает
    const s2 = await api('POST', '/api/uploads', { cookie: e.anna, body: body({ name: 'small.jpg', size: 100 }), ...J });
    const over = await api('PATCH', `/api/uploads/${s2.json.id}`, { cookie: e.anna, body: Buffer.alloc(200, 1), type: 'application/octet-stream', headers: { 'upload-offset': '0' } });
    assert.equal(over.status, 413);
    assert.equal((await api('DELETE', `/api/uploads/${s2.json.id}`, { cookie: e.anna })).status, 200);
    // без Content-Type и без смещения нельзя
    const s3 = await api('POST', '/api/uploads', { cookie: e.anna, body: body({ name: 'x.jpg', size: 10 }), ...J });
    assert.equal((await api('PATCH', `/api/uploads/${s3.json.id}`, { cookie: e.anna, body: Buffer.alloc(10), type: 'text/plain', headers: { 'upload-offset': '0' } })).status, 415);
    assert.equal((await api('PATCH', `/api/uploads/${s3.json.id}`, { cookie: e.anna, body: Buffer.alloc(10), type: 'application/octet-stream' })).status, 400);
    assert.equal((await api('POST', '/api/uploads', { cookie: e.anna, body: body({ name: 'virus.exe', size: 10 }), ...J })).status, 415);
  });

  it('докачанный файл, уже лежащий в облаке, не занимает диск второй раз', async () => {
    const data = jpeg('resume-dup', 9000);
    await upload(e.anna, 'dup-src.jpg', data);
    const before = (await libraryFiles()).length;
    const s = await api('POST', '/api/uploads', { cookie: e.boris, body: body({ name: 'dup-copy.jpg', size: data.length }), ...J });
    const r = await api('PATCH', `/api/uploads/${s.json.id}`, { cookie: e.boris, body: data, type: 'application/octet-stream', headers: { 'upload-offset': '0' } });
    assert.equal(r.json.done, true);
    assert.equal(r.json.duplicate, false);
    assert.equal((await libraryFiles()).length, before);
  });

  it('общий альбом: виден по приглашению, файлы читаются, изменять нельзя, закрывается', async () => {
    const f1 = (await upload(e.anna, 'sh1.jpg', jpeg('sh1'), '2026-08-01T10:00:00Z')).json.file.id;
    const f2 = (await upload(e.anna, 'sh2.jpg', jpeg('sh2'), '2026-08-02T10:00:00Z')).json.file.id;
    const priv = (await upload(e.anna, 'private.jpg', jpeg('private'), '2026-08-03T10:00:00Z')).json.file.id;
    const album = (await api('POST', '/api/albums', { cookie: e.anna, body: body({ name: 'Поездка' }), ...J })).json.album.id;
    await api('POST', `/api/albums/${album}/add`, { cookie: e.anna, body: body({ ids: [f1, f2] }), ...J });
    // до приглашения Борис альбома не видит
    assert.equal((await api('GET', '/api/albums', { cookie: e.boris })).json.albums.some((x: any) => x.id === album), false);
    assert.equal((await api('GET', `/api/albums/${album}/files`, { cookie: e.boris })).status, 404);
    assert.equal((await api('GET', `/api/files/${f1}`, { cookie: e.boris })).status, 404);
    // люди для приглашения
    assert.deepEqual((await api('GET', '/api/albums/people', { cookie: e.anna })).json.people.map((x: any) => x.login), ['boris']);
    assert.equal((await api('PUT', `/api/albums/${album}/shares/boris`, { cookie: e.anna, body: '{}', ...J })).status, 200);
    assert.equal((await api('PUT', `/api/albums/${album}/shares/nobody`, { cookie: e.anna, body: '{}', ...J })).status, 404);
    assert.deepEqual((await api('GET', `/api/albums/${album}/shares`, { cookie: e.anna })).json.people.map((x: any) => x.login), ['boris']);
    // Борис видит альбом как чужой, листает и открывает файлы альбома, но не остальные файлы Анны
    const mine = (await api('GET', '/api/albums', { cookie: e.boris })).json.albums.find((x: any) => x.id === album);
    assert.equal(mine.mine, false);
    assert.equal(mine.ownerName, 'anna');
    assert.equal(mine.count, 2);
    const feed = await api('GET', `/api/albums/${album}/files`, { cookie: e.boris });
    assert.deepEqual(feed.json.files.map((x: any) => x.id), [f2, f1]);
    assert.equal((await api('GET', `/api/files/${f1}`, { cookie: e.boris })).status, 200);
    assert.equal((await api('GET', `/api/files/${priv}`, { cookie: e.boris })).status, 404);
    assert.equal((await api('GET', `/api/albums/${album}/zip`, { cookie: e.boris })).status, 200);
    // менять чужой альбом нельзя
    assert.equal((await api('POST', `/api/albums/${album}/add`, { cookie: e.boris, body: body({ ids: [f1] }), ...J })).status, 404);
    assert.equal((await api('PATCH', `/api/albums/${album}`, { cookie: e.boris, body: body({ name: 'моё' }), ...J })).status, 404);
    assert.equal((await api('DELETE', `/api/albums/${album}`, { cookie: e.boris })).status, 404);
    assert.equal((await api('PUT', `/api/albums/${album}/shares/anna`, { cookie: e.boris, body: '{}', ...J })).status, 404);
    // Борис сохраняет альбом себе: диск не растёт, у него свои записи
    const before = (await libraryFiles()).length;
    const save = await api('POST', `/api/albums/${album}/save`, { cookie: e.boris, body: '{}', ...J });
    assert.deepEqual([save.json.added, save.json.skipped, save.json.quota], [2, 0, false]);
    assert.equal((await libraryFiles()).length, before);
    assert.equal((await api('POST', `/api/albums/${album}/save`, { cookie: e.boris, body: '{}', ...J })).json.added, 0);
    // Анна скрыла файл: у Бориса в общем альбоме он пропал, а сохранённая запись осталась
    await api('DELETE', `/api/files/${f1}`, { cookie: e.anna });
    assert.deepEqual((await api('GET', `/api/albums/${album}/files`, { cookie: e.boris })).json.files.map((x: any) => x.id), [f2]);
    assert.equal((await api('GET', `/api/files/${f1}`, { cookie: e.boris })).status, 404);
    assert.ok((await api('GET', '/api/files', { cookie: e.boris })).json.files.some((x: any) => x.name === 'sh1.jpg'));
    // закрыть доступ
    assert.equal((await api('DELETE', `/api/albums/${album}/shares/boris`, { cookie: e.anna })).status, 200);
    assert.equal((await api('GET', `/api/albums/${album}/files`, { cookie: e.boris })).status, 404);
    // человек может сам выйти из чужого альбома
    await api('PUT', `/api/albums/${album}/shares/boris`, { cookie: e.anna, body: '{}', ...J });
    assert.equal((await api('POST', `/api/albums/${album}/leave`, { cookie: e.boris, body: '{}', ...J })).status, 200);
    assert.equal((await api('GET', `/api/albums/${album}/files`, { cookie: e.boris })).status, 404);
  });

  it('массовые действия и очистка корзины убирают записи, но не файлы на диске', async () => {
    const ids: string[] = [];
    for (const n of ['b1', 'b2', 'b3']) ids.push((await upload(e.boris, `${n}.jpg`, jpeg(`bulk-${n}`), '2026-09-01T10:00:00Z')).json.file.id);
    const diskBefore = (await libraryFiles()).length;
    assert.equal((await api('POST', '/api/files/bulk', { cookie: e.boris, body: body({ action: 'hide', ids }), ...J })).json.changed, 3);
    assert.equal((await api('POST', '/api/files/bulk', { cookie: e.boris, body: body({ action: 'hide', ids }), ...J })).json.changed, 0);
    assert.equal((await api('POST', '/api/files/bulk', { cookie: e.boris, body: body({ action: 'restore', ids: [ids[0]] }), ...J })).json.changed, 1);
    assert.equal((await api('POST', '/api/files/bulk', { cookie: e.boris, body: body({ action: 'remove', ids: [ids[0]] }), ...J })).json.changed, 0, 'живой файл так не убрать');
    assert.equal((await api('POST', '/api/files/bulk', { cookie: e.boris, body: body({ action: 'delete', ids }), ...J })).status, 400);
    // чужие номера не затрагиваются
    const annaFile = (await api('GET', '/api/files', { cookie: e.anna })).json.files[0].id;
    assert.equal((await api('POST', '/api/files/bulk', { cookie: e.boris, body: body({ action: 'hide', ids: [annaFile] }), ...J })).json.changed, 0);
    const empty = await api('DELETE', '/api/files/trash', { cookie: e.boris });
    assert.equal(empty.json.removed, 2);
    assert.equal((await api('GET', '/api/files?trashed=1', { cookie: e.boris })).json.files.length, 0);
    assert.equal((await libraryFiles()).length, diskBefore, 'на диске всё осталось');
  });

  it('администратор: файлы без владельца видны, отдаются людям и стираются только им', async () => {
    const orphans = (await intCall('GET', '/internal/files/orphans')).orphans;
    assert.ok(orphans.length >= 2, 'после очистки корзины Бориса остались файлы без владельца');
    const st = await intCall('GET', '/internal/stats');
    assert.equal(st.orphans, orphans.length);
    // отдать одного Анне
    const adopted = await intCall('POST', `/internal/files/${orphans[0].id}/adopt`, { login: 'anna' });
    assert.ok(adopted.fileId);
    assert.equal((await intCall('GET', '/internal/files/orphans')).orphans.length, orphans.length - 1);
    // стереть другой
    const target = orphans[1];
    const before = (await libraryFiles()).length;
    const purged = await intCall('POST', `/internal/files/${target.id}/purge`, {});
    assert.equal(purged.links, 0);
    assert.equal((await libraryFiles()).length, before - 1);
  });

  it('перенос альбома другому человеку без копирования файлов', async () => {
    const f = (await upload(e.anna, 'tr1.jpg', jpeg('transfer-1'), '2026-10-01T10:00:00Z')).json.file.id;
    const album = (await api('POST', '/api/albums', { cookie: e.anna, body: body({ name: 'Для Бориса' }), ...J })).json.album.id;
    await api('POST', `/api/albums/${album}/add`, { cookie: e.anna, body: body({ ids: [f] }), ...J });
    // у Бориса уже есть альбом с таким именем: имя получит номер
    await api('POST', '/api/albums', { cookie: e.boris, body: body({ name: 'Для Бориса' }), ...J });
    const disk = (await libraryFiles()).length;
    const all = await intCall('GET', '/internal/albums');
    assert.ok(all.albums.some((a: any) => a.id === album && a.owner === 'anna'));
    const r = await intCall('POST', `/internal/albums/${album}/transfer`, { login: 'boris' });
    assert.equal(r.linked, 1);
    assert.equal((await libraryFiles()).length, disk, 'файлы не копировались');
    const boris = (await api('GET', '/api/albums', { cookie: e.boris })).json.albums;
    const got = boris.find((a: any) => a.id === r.albumId);
    assert.equal(got.name, 'Для Бориса (2)');
    assert.equal(got.count, 1);
    assert.ok((await api('GET', '/api/files', { cookie: e.boris })).json.files.some((x: any) => x.name === 'tr1.jpg'));
    // у Анны альбом остался (move=false)
    assert.ok((await api('GET', '/api/albums', { cookie: e.anna })).json.albums.some((a: any) => a.id === album));
  });

  it('смена хозяина альбома: файлы уходят вместе с альбомом, у прежнего хозяина пропадают и из других альбомов', async () => {
    const f1 = (await upload(e.anna, 'mv1.jpg', jpeg('move-1'), '2026-10-03T10:00:00Z')).json.file.id;
    const f2 = (await upload(e.anna, 'mv2.jpg', jpeg('move-2'), '2026-10-03T11:00:00Z')).json.file.id;
    const album = (await api('POST', '/api/albums', { cookie: e.anna, body: body({ name: 'Уезжает' }), ...J })).json.album.id;
    const other = (await api('POST', '/api/albums', { cookie: e.anna, body: body({ name: 'Остаётся' }), ...J })).json.album.id;
    await api('POST', `/api/albums/${album}/add`, { cookie: e.anna, body: body({ ids: [f1, f2] }), ...J });
    await api('POST', `/api/albums/${other}/add`, { cookie: e.anna, body: body({ ids: [f1] }), ...J });
    const pv = await intCall('GET', `/internal/albums/${album}/transfer-preview`);
    assert.deepEqual({ files: pv.files, inOtherAlbums: pv.inOtherAlbums, owner: pv.owner }, { files: 2, inOtherAlbums: 1, owner: 'anna' });
    const disk = (await libraryFiles()).length;
    const r = await intCall('POST', `/internal/albums/${album}/transfer`, { login: 'boris', move: true });
    assert.equal(r.linked, 2);
    assert.equal(r.removedFromOwner, 2);
    assert.equal((await libraryFiles()).length, disk, 'файлы на диске остались');
    const annaFiles = (await api('GET', '/api/files', { cookie: e.anna })).json.files;
    assert.ok(!annaFiles.some((x: any) => x.name === 'mv1.jpg' || x.name === 'mv2.jpg'), 'у прежнего хозяина записей нет');
    assert.ok(!(await api('GET', '/api/albums', { cookie: e.anna })).json.albums.some((a: any) => a.id === album));
    const borisFiles = (await api('GET', '/api/files', { cookie: e.boris })).json.files;
    assert.ok(borisFiles.some((x: any) => x.name === 'mv1.jpg') && borisFiles.some((x: any) => x.name === 'mv2.jpg'));
  });

  it('админ удаляет альбом: файлы людей остаются', async () => {
    const f = (await upload(e.anna, 'ad1.jpg', jpeg('admin-del-1'), '2026-10-02T10:00:00Z')).json.file.id;
    const album = (await api('POST', '/api/albums', { cookie: e.anna, body: body({ name: 'Лишний' }), ...J })).json.album.id;
    await api('POST', `/api/albums/${album}/add`, { cookie: e.anna, body: body({ ids: [f] }), ...J });
    const del = await fetch(`${e.intBase}/internal/albums/${album}`, { method: 'DELETE', headers: { authorization: `Bearer ${e.token}` } });
    assert.equal(del.status, 200);
    assert.ok(!(await api('GET', '/api/albums', { cookie: e.anna })).json.albums.some((a: any) => a.id === album));
    assert.ok((await api('GET', '/api/files', { cookie: e.anna })).json.files.some((x: any) => x.id === f));
    const again = await fetch(`${e.intBase}/internal/albums/${album}`, { method: 'DELETE', headers: { authorization: `Bearer ${e.token}` } });
    assert.equal(again.status, 404);
  });

  it('удаление аккаунта: с файлами только по force, файлы на диске остаются без владельца', async () => {
    const tmp = await e.loginAs('temp');
    await upload(tmp, 'temp.jpg', jpeg('temp-user-file', 4000));
    const disk = (await libraryFiles()).length;
    const refused = await fetch(`${e.intBase}/internal/users/temp`, { method: 'DELETE', headers: { authorization: `Bearer ${e.token}` } });
    assert.equal(refused.status, 409);
    const ok = await fetch(`${e.intBase}/internal/users/temp?force=1`, { method: 'DELETE', headers: { authorization: `Bearer ${e.token}` } });
    assert.equal(ok.status, 200);
    assert.equal((await libraryFiles()).length, disk);
    assert.ok((await intCall('GET', '/internal/files/orphans')).orphans.some((o: any) => o.name === 'temp.jpg' || o.size > 0));
  });

  it('администратор: все файлы без владельца стираются разом, только с верным числом, чужие файлы целы', async () => {
    const st = await intCall('GET', '/internal/stats');
    assert.ok(st.orphans >= 1 && st.orphanBytes > 0, 'есть что стирать');
    const live = (await api('GET', '/api/files', { cookie: e.anna })).json.files.length;
    const disk = (await libraryFiles()).length;
    const post = (confirm: unknown) => fetch(`${e.intBase}/internal/files/orphans/purge`, { method: 'POST', headers: { authorization: `Bearer ${e.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ confirm }) });
    assert.equal((await post(st.orphans + 1)).status, 409, 'другое число: ничего не стирается');
    assert.equal((await post('много')).status, 400);
    assert.equal((await libraryFiles()).length, disk);
    const ok = await post(st.orphans);
    assert.equal(ok.status, 200);
    const r = (await ok.json()) as { count: number; bytes: number; skipped: number };
    assert.equal(r.count, st.orphans);
    assert.equal(r.bytes, st.orphanBytes);
    assert.equal(r.skipped, 0);
    assert.equal((await libraryFiles()).length, disk - st.orphans, 'с диска ушли только файлы без владельца');
    assert.equal((await api('GET', '/api/files', { cookie: e.anna })).json.files.length, live, 'файлы людей целы');
    const after = await intCall('GET', '/internal/stats');
    assert.equal(after.orphans, 0);
    assert.equal(after.orphanBytes, 0);
    assert.equal((await post(0)).status, 200, 'повтор при нуле безопасен');
  });

  it('скриншоты: PNG размером с экран уходит из библиотеки в «скриншоты», обычное фото остаётся', async () => {
    const sharp = (await import('sharp')).default;
    const shot = await sharp({ create: { width: 1080, height: 2400, channels: 3, background: '#223344' } }).png().toBuffer();
    const photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#aa5522' } }).jpeg().withExif({ IFD0: { Make: 'TestCam' } }).toBuffer();
    const s1 = (await upload(e.anna, 'Screenshot_1.png', shot)).json.file.id;
    const p1 = (await upload(e.anna, 'IMG_9.jpg', photo)).json.file.id;
    let shots: string[] = [];
    for (let i = 0; i < 40 && shots.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 250));
      shots = (await api('GET', '/api/files?kind=screenshots', { cookie: e.anna })).json.files.map((f: any) => f.id);
    }
    assert.deepEqual(shots, [s1]);
    const lib = (await api('GET', '/api/files?kind=photos', { cookie: e.anna })).json.files.map((f: any) => f.id);
    assert.ok(lib.includes(p1) && !lib.includes(s1));
    assert.ok((await api('GET', '/api/files', { cookie: e.anna })).json.files.some((f: any) => f.id === s1), 'без kind видно всё');
    assert.equal((await api('GET', '/api/files?kind=x', { cookie: e.anna })).status, 400);
  });

  it('разделы ленты: фото, видео и скриншоты не пересекаются, без kind видно всё', async () => {
    const sharp = (await import('sharp')).default;
    const pic = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#778899' } }).jpeg().withExif({ IFD0: { Make: 'TestCam' } }).toBuffer();
    const p = (await upload(e.boris, 'kind-photo.jpg', pic)).json.file.id;
    const v = (await upload(e.boris, 'kind-video.mp4', Buffer.from('0000ftypmp42' + 'k'.repeat(400)))).json.file.id;
    const ids = async (q: string) => (await api('GET', `/api/files${q}`, { cookie: e.boris })).json.files.map((f: any) => f.id);
    const all = await ids('');
    assert.ok(all.includes(p) && all.includes(v));
    const photos = await ids('?kind=photos');
    assert.ok(photos.includes(p) && !photos.includes(v), 'в фото нет видео');
    const videos = await ids('?kind=videos');
    assert.ok(videos.includes(v) && !videos.includes(p), 'в видео только видео');
    assert.ok(!(await ids('?kind=screenshots')).includes(v));
  });
});
