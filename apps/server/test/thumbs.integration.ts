// Миниатюры на настоящем Postgres и диске: размер, поворот, чужие файлы, корзина, удаление. Запуск: npm run test:db
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stat, readFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { startEnv } from './helpers/filesenv';
import { TINY_HEIC } from './helpers/heic-fixture';

// Настоящая картинка: 1200x800 с меткой поворота «на 90 градусов», после поворота должна стать 800x1200.
async function photo(color: string): Promise<Buffer> {
  return sharp({ create: { width: 1200, height: 800, channels: 3, background: color } }).jpeg({ quality: 90 }).withMetadata({ orientation: 6 }).toBuffer();
}

function hasHeif(): boolean {
  for (const c of ['heif-dec', 'heif-convert']) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return true;
    }
  }
  return false;
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

  const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  it('у настоящего видео есть миниатюра-кадр', { skip: !hasFfmpeg && 'нет ffmpeg' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dvc-vid-'));
    try {
      const f = join(dir, 'c.mp4');
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=2', '-pix_fmt', 'yuv420p', f]);
      const up = await upload(e.anna, 'real.mp4', await readFile(f));
      assert.equal(up.status, 201);
      const t = await api('GET', `/api/files/${up.json.file.id}/thumb`, { cookie: e.anna });
      assert.equal(t.status, 200);
      const meta = await sharp(t.buf).metadata();
      assert.equal(meta.format, 'webp');
      assert.equal((await api('GET', `/api/files/${up.json.file.id}/preview`, { cookie: e.anna })).status, 404);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('у HEIC-фото есть миниатюра и превью (раньше было 404), оригинал отдаётся как был', { skip: !hasHeif() && 'нет libheif-tools' }, async () => {
    const up = await upload(e.anna, 'IMG_0001.heic', TINY_HEIC);
    assert.equal(up.status, 201);
    const id = up.json.file.id;
    const t = await api('GET', `/api/files/${id}/thumb`, { cookie: e.anna });
    assert.equal(t.status, 200, 'миниатюра HEIC');
    assert.equal(t.headers.get('content-type'), 'image/webp');
    assert.equal((await sharp(t.buf).metadata()).width, 560);
    const p = await api('GET', `/api/files/${id}/preview`, { cookie: e.anna });
    assert.equal(p.status, 200, 'превью HEIC для просмотра');
    assert.equal((await sharp(p.buf).metadata()).format, 'webp');
    const o = await api('GET', `/api/files/${id}`, { cookie: e.anna });
    assert.equal(o.status, 200);
    assert.deepEqual(o.buf, TINY_HEIC, 'оригинал не изменён');
  });

  it('миниатюра «вписанная» (?fit=1) сохраняет пропорции, лежит отдельно, а в списке есть поля width и height', async () => {
    const wide = await sharp({ create: { width: 1200, height: 300, channels: 3, background: '#2266dd' } }).jpeg().toBuffer();
    const up = await upload(e.anna, 'wide-fit.jpg', wide);
    assert.equal(up.status, 201);
    const id = up.json.file.id;
    const t = await api('GET', `/api/files/${id}/thumb?fit=1`, { cookie: e.anna });
    assert.equal(t.status, 200);
    const m = await sharp(t.buf).metadata();
    assert.equal(m.width, 640, 'длинная сторона 640');
    assert.equal(m.height, 160, 'пропорции 4:1 сохранены');
    assert.ok((await e.walk(join(e.dataDir, 'thumbs-fit'))).length >= 1, 'лежит в своей папке');
    const sq = await api('GET', `/api/files/${id}/thumb`, { cookie: e.anna });
    assert.equal((await sharp(sq.buf).metadata()).width, 560, 'обычная миниатюра прежняя');
    const list = await api('GET', '/api/files?limit=200', { cookie: e.anna });
    const item = (list.json.files ?? list.json.items).find((x: { id: string }) => x.id === id);
    assert.ok(item && 'width' in item && 'height' in item, 'поля есть (число или null, пока отпечаток не посчитан)');
  });

  it('окончательное удаление записи не трогает общую миниатюру: она уходит вместе с файлом-оригиналом', async () => {
    const up = await upload(e.boris, 'gone.jpg', await photo('#33cc66'));
    const id = up.json.file.id;
    assert.equal((await api('GET', `/api/files/${id}/thumb`, { cookie: e.boris })).status, 200);
    const before = (await e.walk(join(e.dataDir, 'thumbs'))).length;
    await api('DELETE', `/api/files/${id}`, { cookie: e.boris });
    await api('DELETE', `/api/files/${id}?permanent=1`, { cookie: e.boris });
    assert.equal((await e.walk(join(e.dataDir, 'thumbs'))).length, before, 'оригинал ещё на диске, миниатюра при нём');
    // администратор стирает оригинал: миниатюра уходит
    const o = await e.intCall('GET', '/internal/files/orphans');
    const gone = o.orphans.find((x: { name: string }) => x.name === 'gone.jpg');
    assert.ok(gone, 'оригинал остался без владельца');
    const blobId = gone.id;
    assert.equal((await e.intCall('POST', `/internal/files/${blobId}/purge`)).links, 0);
    assert.equal((await e.walk(join(e.dataDir, 'thumbs'))).length, before - 1);
  });

  it('один и тот же файл у двух людей: миниатюра одна на всех, доступ у каждого по своей записи', async () => {
    const buf = await photo('#aa44cc');
    const a = await upload(e.anna, 'same-a.jpg', buf);
    const b = await upload(e.boris, 'same-b.jpg', buf);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    const before = (await e.walk(join(e.dataDir, 'thumbs'))).length;
    const ta = await api('GET', `/api/files/${a.json.file.id}/thumb`, { cookie: e.anna });
    const tb = await api('GET', `/api/files/${b.json.file.id}/thumb`, { cookie: e.boris });
    assert.equal(ta.status, 200);
    assert.equal(tb.status, 200);
    assert.deepEqual(ta.buf, tb.buf);
    assert.equal((await e.walk(join(e.dataDir, 'thumbs'))).length, before + 1, 'на диске одна миниатюра на двоих');
    assert.equal((await api('GET', `/api/files/${b.json.file.id}/thumb`, { cookie: e.anna })).status, 404, 'чужая запись по-прежнему закрыта');
    // один убрал свою запись: у второго миниатюра на месте
    await api('DELETE', `/api/files/${a.json.file.id}`, { cookie: e.anna });
    await api('DELETE', `/api/files/${a.json.file.id}?permanent=1`, { cookie: e.anna });
    assert.equal((await api('GET', `/api/files/${b.json.file.id}/thumb`, { cookie: e.boris })).status, 200);
    assert.equal((await e.walk(join(e.dataDir, 'thumbs'))).length, before + 1);
  });

  it('прежние миниатюры по записи переносятся на общие: лениво при запросе и разово при запуске', async () => {
    const { ThumbsService } = await import('../src/files/thumbs.service');
    const ths = e.app.get(ThumbsService);
    const mk = async (name: string, color: string): Promise<string> => {
      const up = await upload(e.anna, name, await photo(color));
      const id = up.json.file.id as string;
      assert.equal((await api('GET', `/api/files/${id}/thumb`, { cookie: e.anna })).status, 200);
      return id;
    };
    // дублируем состояние «до обновления»: файл миниатюры лежит по прежнему пути
    const pg = new (await import('pg')).default.Client({ connectionString: e.dbUrl });
    await pg.connect();
    try {
      const lazy = await mk('lazy.jpg', '#112233');
      const bulk = await mk('bulk.jpg', '#445566');
      const dup = await mk('dup.jpg', '#778899');
      const row = async (id: string) => (await pg.query('SELECT owner_id, blob_id FROM files WHERE id = $1', [id])).rows[0] as { owner_id: string; blob_id: string };
      const { rename, mkdir, writeFile } = await import('node:fs/promises');
      const legacyOf = async (id: string) => { const r = await row(id); return { shared: join(e.dataDir, 'thumbs', `${r.blob_id}.webp`), old: join(e.dataDir, 'thumbs', r.owner_id, `${id}.webp`), dir: join(e.dataDir, 'thumbs', r.owner_id) }; };
      for (const id of [lazy, bulk]) { const l = await legacyOf(id); await mkdir(l.dir, { recursive: true }); await rename(l.shared, l.old); }
      // лениво: первый же запрос подбирает прежнюю миниатюру, без пересчёта
      const l1 = await legacyOf(lazy);
      const t = await api('GET', `/api/files/${lazy}/thumb`, { cookie: e.anna });
      assert.equal(t.status, 200);
      await assert.rejects(stat(l1.old));
      assert.ok((await stat(l1.shared)).size > 0);
      // разово: прежнюю миниатюру и лишнюю копию подбирает перенос, запись без файла-оригинала не трогается
      const l2 = await legacyOf(bulk);
      const l3 = await legacyOf(dup);
      await writeFile(l3.old, 'лишняя копия'); // общая миниатюра этого файла уже на месте: копия должна уйти
      await writeFile(join(l2.dir, '999999.webp'), 'записи нет');
      await rm(join(e.dataDir, '.thumbs-shared-v1'), { force: true });
      const r = await ths.migrateLegacy();
      assert.ok(r.moved >= 1 && r.dropped >= 2, JSON.stringify(r));
      await assert.rejects(stat(l2.old));
      assert.ok((await stat(l2.shared)).size > 0);
      await assert.rejects(stat(l3.old));
      assert.ok((await stat(l3.shared)).size > 0);
      assert.deepEqual(await ths.migrateLegacy(), { moved: 0, dropped: 0 }, 'второй раз ничего не делает');
    } finally {
      await pg.end();
    }
  });

  it('превью для просмотра: WebP не больше 2000 px, у видео и чужих 404', async () => {
    const big = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#3366cc' } }).jpeg().toBuffer();
    const up = await upload(e.anna, 'wide.jpg', big);
    const id = up.json.file.id;
    const r = await api('GET', `/api/files/${id}/preview`, { cookie: e.anna });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/webp');
    const m = await sharp(r.buf).metadata();
    assert.equal(Math.max(m.width ?? 0, m.height ?? 0), 2000);
    assert.equal((await api('GET', `/api/files/${id}/preview`, { cookie: e.boris })).status, 404);
    assert.equal((await api('GET', `/api/files/${id}/preview`)).status, 401);
  });
});
