// Сейф на настоящем Postgres и диске: файлы забираются у владельца, не стираются ни одним способом, возвращаются и стираются отдельно.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';
import { startEnv } from './helpers/filesenv';

const J = { type: 'application/json' };
const body = (o: unknown) => JSON.stringify(o);

describe('сейф (настоящий Postgres и диск)', () => {
  const e = startEnv();
  const { api, upload, jpeg, intCall } = e;
  let pg: Client;
  let album = '';
  const f: Record<string, string> = {};
  const exists = (p: string) => access(join(e.dataDir, p)).then(() => true, () => false);
  const blobPath = async (fileId: string) => (await pg.query('SELECT b.path FROM files f JOIN blobs b ON b.id = f.blob_id WHERE f.id = $1', [fileId])).rows[0]?.path as string;

  before(async () => {
    await e.start();
    pg = new Client({ connectionString: e.dbUrl });
    await pg.connect();
    f.one = (await upload(e.anna, 'one.jpg', jpeg('vault-one'), '2026-05-01T10:00:00Z')).json.file.id;
    f.two = (await upload(e.anna, 'two.jpg', jpeg('vault-two'), '2026-05-02T10:00:00Z')).json.file.id;
    f.shared = (await upload(e.anna, 'shared.jpg', jpeg('vault-shared'), '2026-05-03T10:00:00Z')).json.file.id;
    f.boris = (await upload(e.boris, 'same-as-shared.jpg', jpeg('vault-shared'))).json.file.id; // то же содержимое у Бориса
    album = (await api('POST', '/api/albums', { cookie: e.anna, body: body({ name: 'Личное' }), ...J })).json.album.id;
    await api('POST', `/api/albums/${album}/add`, { cookie: e.anna, body: body({ ids: [f.one, f.two, f.shared] }), ...J });
  });
  after(async () => { await pg.end(); await e.stop(); });

  it('в сейф: у владельца исчезают альбом и записи о файлах, файлы остаются на диске, Борис свой файл сохраняет', async () => {
    const paths = [await blobPath(f.one), await blobPath(f.two), await blobPath(f.shared)];
    const r = await intCall('POST', `/internal/albums/${album}/to-vault`, { note: 'на всякий' });
    assert.equal(r.files, 3);
    assert.equal((await api('GET', '/api/albums', { cookie: e.anna })).json.albums.length, 0, 'альбома у владельца нет');
    for (const id of [f.one, f.two, f.shared]) assert.equal((await api('GET', `/api/files/${id}`, { cookie: e.anna })).status, 404, 'записей о файлах нет');
    assert.equal((await api('GET', `/api/files/${f.boris}`, { cookie: e.boris })).status, 200, 'у Бориса свой файл на месте');
    for (const p of paths) assert.ok(await exists(p), `на диске ${p}`);
    const v = (await intCall('GET', '/internal/vault')).albums;
    assert.equal(v.length, 1);
    assert.equal(v[0].count, 3);
    assert.equal(v[0].fromLogin, 'anna');
    assert.equal(v[0].note, 'на всякий');
  });

  it('сейф защищён: файлы не видны как «без владельца», не стираются очисткой, чисткой и прямым удалением', async () => {
    const st = await intCall('GET', '/internal/stats');
    assert.equal(st.orphans, 0, 'в сейфе нет «бесхозных»');
    assert.equal((await intCall('GET', '/internal/files/orphans')).orphans.length, 0);
    const blobs = (await pg.query('SELECT b.id, b.path FROM vault_items i JOIN blobs b ON b.id = i.blob_id ORDER BY b.id')).rows;
    assert.equal(blobs.length, 3);
    const purgeAll = await intCall('POST', '/internal/files/orphans/purge', { confirm: 0 });
    assert.equal(purgeAll.count, 0);
    for (const b of blobs) {
      const direct = await fetch(`${e.intBase}/internal/files/${b.id}/purge`, { method: 'POST', headers: { authorization: `Bearer ${e.token}`, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(direct.status, 409, 'прямое стирание отклонено');
      assert.ok(await exists(b.path), 'файл на месте');
    }
    // и сама база не даёт удалить оригинал из сейфа
    await assert.rejects(pg.query('DELETE FROM blobs WHERE id = $1', [blobs[0].id]), /vault_items/);
  });

  it('вернуть: у человека появляется альбом с файлами, прежние имена и даты сохранены, сейф пустеет', async () => {
    const v = (await intCall('GET', '/internal/vault')).albums[0];
    assert.equal((await fetch(`${e.intBase}/internal/vault/${v.id}/return`, { method: 'POST', headers: { authorization: `Bearer ${e.token}`, 'content-type': 'application/json' }, body: body({ login: 'nobody' }) })).status, 404);
    const r = await intCall('POST', `/internal/vault/${v.id}/return`, { login: 'boris' });
    assert.equal(r.linked, 3);
    const list = (await api('GET', '/api/albums', { cookie: e.boris })).json.albums;
    const back = list.find((a: any) => a.name === 'Личное');
    assert.ok(back && back.count === 3, JSON.stringify(list));
    const files = (await api('GET', `/api/albums/${back.id}/files`, { cookie: e.boris })).json.files;
    assert.deepEqual(files.map((x: any) => x.name).sort(), ['one.jpg', 'same-as-shared.jpg', 'two.jpg'].sort(), 'имена сохранены (общий файл у Бориса уже был под своим именем)');
    assert.equal((await intCall('GET', '/internal/vault')).albums.length, 0);
  });

  it('стереть из сейфа: файл уходит с диска, а тот, что есть у другого человека, остаётся', async () => {
    const solo = (await upload(e.anna, 'solo.jpg', jpeg('vault-solo'))).json.file.id;
    const withBoris = (await upload(e.anna, 'with-boris.jpg', jpeg('vault-shared-2'))).json.file.id;
    await upload(e.boris, 'boris-copy.jpg', jpeg('vault-shared-2'));
    const soloPath = await blobPath(solo);
    const sharedPath = await blobPath(withBoris);
    const a2 = (await api('POST', '/api/albums', { cookie: e.anna, body: body({ name: 'Секрет' }), ...J })).json.album.id;
    await api('POST', `/api/albums/${a2}/add`, { cookie: e.anna, body: body({ ids: [solo, withBoris] }), ...J });
    const put = await intCall('POST', `/internal/albums/${a2}/to-vault`, {});
    const v = (await intCall('GET', '/internal/vault')).albums[0];
    assert.equal(v.count, 2);
    const er = await intCall('DELETE', `/internal/vault/${v.id}`);
    assert.equal(er.files, 1, 'стёрт один файл');
    assert.equal(er.kept, 1, 'второй есть у Бориса');
    assert.equal(await exists(soloPath), false, 'файл ушёл с диска');
    assert.equal(await exists(sharedPath), true, 'файл Бориса на месте');
    assert.equal((await intCall('GET', '/internal/vault')).albums.length, 0);
    assert.ok(put.vaultId);
  });

  it('«Отдать» файл без владельца возвращает исходное имя и дату', async () => {
    const id = (await upload(e.anna, 'памятное.jpg', jpeg('vault-orphan'), '2025-01-02T03:04:05Z')).json.file.id;
    await api('DELETE', `/api/files/${id}`, { cookie: e.anna });
    assert.equal((await api('DELETE', `/api/files/${id}?permanent=1`, { cookie: e.anna })).status, 200);
    const o = (await intCall('GET', '/internal/files/orphans')).orphans.find((x: any) => x.name === 'памятное.jpg');
    assert.ok(o, 'в списке под исходным именем');
    const adopted = await intCall('POST', `/internal/files/${o.id}/adopt`, { login: 'boris' });
    const row = (await pg.query('SELECT original_name, taken_at FROM files WHERE id = $1', [adopted.fileId])).rows[0];
    assert.equal(row.original_name, 'памятное.jpg');
    assert.equal(new Date(row.taken_at).toISOString(), '2025-01-02T03:04:05.000Z');
  });
});
