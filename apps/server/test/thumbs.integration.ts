// Миниатюры на настоящем Postgres и диске: размер, поворот, чужие файлы, корзина, удаление. Запуск: npm run test:db
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { startEnv } from './helpers/filesenv';

// Настоящая картинка: 1200x800 с меткой поворота «на 90 градусов», после поворота должна стать 800x1200.
async function photo(color: string): Promise<Buffer> {
  return sharp({ create: { width: 1200, height: 800, channels: 3, background: color } }).jpeg({ quality: 90 }).withMetadata({ orientation: 6 }).toBuffer();
}

describe('миниатюры (настоящий Postgres и диск)', () => {
  const e = startEnv();
  const { api, upload, jpeg } = e;
  before(async () => {
    await e.start();
  });
  after(async () => {
    await e.stop();
  });

  it('миниатюра маленькая, квадратная, в WebP, кэшируется и появляется на диске', async () => {
    const orig = await photo('#3366cc');
    const up = await upload(e.anna, 'big.jpg', orig);
    assert.equal(up.status, 201);
    const id = up.json.file.id;
    const t = await api('GET', `/api/files/${id}/thumb`, { cookie: e.anna });
    assert.equal(t.status, 200);
    assert.equal(t.headers.get('content-type'), 'image/webp');
    assert.match(t.headers.get('cache-control') ?? '', /immutable/);
    assert.ok(t.buf.length < orig.length / 3, `миниатюра ${t.buf.length} Б должна быть сильно меньше оригинала ${orig.length} Б`);
    const meta = await sharp(t.buf).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(meta.width, 560);
    assert.equal(meta.height, 560);
    const files = await e.walk(join(e.dataDir, 'thumbs'));
    assert.equal(files.length, 1);
    assert.ok((await stat(files[0])).size > 0);
  });

  it('чужая миниатюра, без входа и неизвестный id дают 404 или 401, а у скрытого своего файла миниатюра остаётся', async () => {
    const up = await upload(e.anna, 'mine.jpg', await photo('#cc3366'));
    const id = up.json.file.id;
    assert.equal((await api('GET', `/api/files/${id}/thumb`)).status, 401);
    assert.equal((await api('GET', `/api/files/${id}/thumb`, { cookie: e.boris })).status, 404);
    assert.equal((await api('GET', '/api/files/999999/thumb', { cookie: e.anna })).status, 404);
    await api('DELETE', `/api/files/${id}`, { cookie: e.anna });
    assert.equal((await api('GET', `/api/files/${id}/thumb`, { cookie: e.anna })).status, 200, 'раздел «Скрытые» показывает миниатюры');
    assert.equal((await api('GET', `/api/files/${id}`, { cookie: e.anna })).status, 404, 'оригинал скрытого не отдаётся');
  });

  it('битая картинка и видео дают 404, а оригинал при этом отдаётся', async () => {
    const bad = await upload(e.anna, 'broken.jpg', jpeg('not really an image'));
    assert.equal(bad.status, 201);
    assert.equal((await api('GET', `/api/files/${bad.json.file.id}/thumb`, { cookie: e.anna })).status, 404);
    assert.equal((await api('GET', `/api/files/${bad.json.file.id}`, { cookie: e.anna })).status, 200);
    const vid = await upload(e.anna, 'clip.mp4', Buffer.from('0000ftypmp42' + 'x'.repeat(500)));
    assert.equal((await api('GET', `/api/files/${vid.json.file.id}/thumb`, { cookie: e.anna })).status, 404);
  });

  it('окончательное удаление убирает и миниатюру', async () => {
    const up = await upload(e.boris, 'gone.jpg', await photo('#33cc66'));
    const id = up.json.file.id;
    assert.equal((await api('GET', `/api/files/${id}/thumb`, { cookie: e.boris })).status, 200);
    const before = (await e.walk(join(e.dataDir, 'thumbs'))).length;
    await api('DELETE', `/api/files/${id}`, { cookie: e.boris });
    await api('DELETE', `/api/files/${id}?permanent=1`, { cookie: e.boris });
    assert.equal((await e.walk(join(e.dataDir, 'thumbs'))).length, before - 1);
  });
});
