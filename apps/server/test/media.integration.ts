import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import sharp from 'sharp';
import { startEnv } from './helpers/filesenv';

process.env.DVCLOUD_VIDEO_TICK_MS = '300'; // фоновые копии видео проверяем быстро
process.env.DVCLOUD_FP_TICK_MS = '300'; // и фоновую работу с отпечатками

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('настройки превью и видео в админке (настоящий Postgres и диск)', () => {
  const e = startEnv();
  const { api, upload, intCall } = e;
  const patch = (body: unknown) =>
    fetch(`${e.intBase}/internal/media/settings`, { method: 'PATCH', headers: { authorization: `Bearer ${e.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const wait = async (check: () => Promise<boolean>, ms = 40_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  };
  before(async () => {
    await e.start();
  });
  after(async () => {
    await e.stop();
  });

  it('по умолчанию: превью включены (2000, 80), видео выключено', async () => {
    const o = await intCall('GET', '/internal/media');
    assert.deepEqual(o.settings, { previewEnabled: true, previewMaxSide: 2000, previewQuality: 80, videoEnabled: false, videoHeight: 720, videoCrf: 28, timezone: 'UTC', searchEnabled: false, searchCutoff: 80, facesEnabled: false, petsEnabled: false, facesSim: 45 });
    assert.equal(o.previews.files, 0);
  });

  it('размер превью берётся из настроек; смена размера стирает старые превью; выключение отдаёт 404', async () => {
    const img = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#3366cc' } }).jpeg().toBuffer();
    const id = (await upload(e.anna, 'big.jpg', img)).json.file.id;
    const first = await api('GET', `/api/files/${id}/preview`, { cookie: e.anna });
    assert.equal(first.status, 200);
    assert.equal((await sharp(first.buf).metadata()).width, 2000);
    assert.equal((await intCall('GET', '/internal/media')).previews.files, 1);

    const r = await patch({ previewMaxSide: 1000 });
    assert.equal(r.status, 200);
    assert.deepEqual(((await r.json()) as any).cleared, ['previews']);
    assert.equal((await intCall('GET', '/internal/media')).previews.files, 0, 'старые превью стёрты');
    await new Promise((r2) => setTimeout(r2, 2500)); // публичный порт обновляет кэш настроек раз в пару секунд
    const second = await api('GET', `/api/files/${id}/preview`, { cookie: e.anna });
    assert.equal((await sharp(second.buf).metadata()).width, 1000);

    assert.equal((await patch({ previewEnabled: false })).status, 200);
    await new Promise((r2) => setTimeout(r2, 2500));
    assert.equal((await api('GET', `/api/files/${id}/preview`, { cookie: e.anna })).status, 404);
    assert.equal((await api('GET', `/api/files/${id}`, { cookie: e.anna })).status, 200, 'оригинал по-прежнему отдаётся');
    await patch({ previewEnabled: true });
    await new Promise((r2) => setTimeout(r2, 2500));
  });

  it('плохие значения отклоняются, очистка принимает только известные каталоги', async () => {
    assert.equal((await patch({ previewMaxSide: 50 })).status, 400);
    assert.equal((await patch({ nope: 1 })).status, 400);
    assert.equal((await patch({})).status, 400);
    const bad = await fetch(`${e.intBase}/internal/media/clear`, { method: 'POST', headers: { authorization: `Bearer ${e.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ what: 'library' }) });
    assert.equal(bad.status, 400);
    const noAuth = await fetch(`${e.intBase}/internal/media`);
    assert.equal(noAuth.status, 401);
  });

  it('старые отпечатки без отметки перепроверяются в фоне, и скриншот находится', async () => {
    const png = await sharp({ create: { width: 1080, height: 2400, channels: 3, background: '#112233' } }).png().toBuffer();
    const id = (await upload(e.anna, 'old-shot.png', png)).json.file.id;
    const shots = async () => (await api('GET', '/api/files?kind=screenshots', { cookie: e.anna })).json.files.map((f: any) => f.id);
    assert.ok(await wait(async () => (await shots()).includes(id)), 'новый скриншот не нашёлся');
    // как у файла, чей отпечаток посчитан старой версией: отметки нет, проверки не было
    const c = new Client({ connectionString: e.dbUrl });
    await c.connect();
    try {
      await c.query('UPDATE file_fingerprints SET screenshot = false, shot_checked = false WHERE file_id = $1', [id]);
      assert.ok(await wait(async () => (await shots()).includes(id)), 'старый отпечаток не перепроверился');
      assert.equal((await c.query('SELECT shot_checked FROM file_fingerprints WHERE file_id = $1', [id])).rows[0].shot_checked, true);
    } finally {
      await c.end();
    }
  });

  it('ручная смена «фото» и «скриншот»: выбор сильнее автоматики, видно в списке, чужое не тронуть', async () => {
    const kinds = async (k: string) => (await api('GET', `/api/files?kind=${k}`, { cookie: e.anna })).json.files as any[];
    const post = (cookie: string, body: unknown) => api('POST', '/api/files/kind', { cookie, body: JSON.stringify(body), type: 'application/json' });
    const photo = (await upload(e.anna, 'plain-photo.jpg', await sharp({ create: { width: 800, height: 600, channels: 3, background: '#445566' } }).jpeg().toBuffer())).json.file.id;
    const shot = (await upload(e.anna, 'real-shot.png', await sharp({ create: { width: 1080, height: 2340, channels: 3, background: '#665544' } }).png().toBuffer())).json.file.id;
    assert.ok(await wait(async () => (await kinds('screenshots')).some((f) => f.id === shot)), 'автоматика нашла скриншот');
    assert.ok((await kinds('photos')).some((f) => f.id === photo));
    assert.equal((await post(e.anna, { kind: 'screenshot', ids: [photo] })).json.changed, 1);
    assert.ok((await kinds('screenshots')).some((f) => f.id === photo), 'фото отнесено к скриншотам');
    assert.ok(!(await kinds('photos')).some((f) => f.id === photo));
    assert.equal((await kinds('screenshots')).find((f) => f.id === photo).screenshot, true, 'в списке видно, что это скриншот');
    assert.ok(!(await kinds('library')).some((f) => f.id === photo || f.id === shot), 'в «Библиотеке» скриншотов нет, в том числе отмеченных вручную');
    assert.equal((await post(e.anna, { kind: 'photo', ids: [shot] })).json.changed, 1);
    assert.ok((await kinds('photos')).some((f) => f.id === shot), 'скриншот отнесён к фото');
    assert.ok((await kinds('library')).some((f) => f.id === shot), 'отнесённый к фото попал в «Библиотеку»');
    assert.ok(!(await kinds('screenshots')).some((f) => f.id === shot));
    assert.equal((await post(e.anna, { kind: 'photo', ids: [shot] })).json.changed, 0, 'повтор ничего не меняет');
    assert.equal((await post(e.boris, { kind: 'screenshot', ids: [shot] })).json.changed, 0, 'чужие файлы не тронуть');
    assert.equal((await post(e.anna, { kind: 'другое', ids: [shot] })).status, 400);
    assert.equal((await post(e.anna, { kind: 'photo', ids: [] })).status, 400);
    assert.equal((await post(e.anna, { kind: 'auto', ids: [photo, shot] })).json.changed, 2);
    assert.ok((await kinds('photos')).some((f) => f.id === photo) && (await kinds('screenshots')).some((f) => f.id === shot), 'после сброса снова решает автоматика');
  });

  it('дата съёмки: метаданные главнее имени файла, имя главнее даты изменения, пояс берётся из настроек', async () => {
    const img = (seed: string) => sharp({ create: { width: 64, height: 48, channels: 3, background: seed } });
    const takenOf = async (id: string) => (await api('GET', '/api/files', { cookie: e.anna })).json.files.find((f: any) => f.id === id).takenAt;
    const mod = '2025-07-01T09:45:00Z'; // дата изменения, как у копии файла
    const byName = (await upload(e.anna, '2020-05-25 18-55-28.jpg', await img('#101010').jpeg().toBuffer(), mod)).json.file.id;
    assert.equal(await takenOf(byName), '2020-05-25T18:55:28.000Z', 'дата из имени, а не из даты изменения');
    const plain = (await upload(e.anna, 'IMG_0001.jpg', await img('#202020').jpeg().toBuffer(), mod)).json.file.id;
    assert.equal(await takenOf(plain), '2025-07-01T09:45:00.000Z', 'без данных остаётся дата изменения');
    const withExif = await img('#303030').jpeg().withExif({ IFD2: { DateTimeOriginal: '2018:03:04 05:06:07' } }).toBuffer();
    const ex = (await upload(e.anna, 'IMG_20190101_000000.jpg', withExif, mod)).json.file.id;
    assert.equal(await takenOf(ex), '2018-03-04T05:06:07.000Z', 'EXIF главнее имени файла');

    assert.equal((await patch({ timezone: 'Europe/Moscow' })).status, 200);
    await new Promise((r2) => setTimeout(r2, 2500));
    const msk = (await upload(e.anna, '2021-01-02 10-00-00.jpg', await img('#404040').jpeg().toBuffer(), mod)).json.file.id;
    assert.equal(await takenOf(msk), '2021-01-02T07:00:00.000Z', 'время из имени переведено из московского пояса');
    assert.equal((await patch({ timezone: 'Нигде/Никогда' })).status, 400);
    assert.equal((await patch({ timezone: 'UTC' })).status, 200);
    await new Promise((r2) => setTimeout(r2, 2500));
  });

  it('пересчёт дат у загруженных: сначала проверка без изменений, потом применение', async () => {
    const img = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#505050' } }).jpeg().toBuffer();
    const id = (await upload(e.boris, 'PXL_20170809_101112.jpg', img, '2025-07-01T09:45:00Z')).json.file.id;
    const takenOf = async () => (await api('GET', '/api/files', { cookie: e.boris })).json.files.find((f: any) => f.id === id).takenAt;
    const c = new Client({ connectionString: e.dbUrl });
    await c.connect();
    try {
      await c.query("UPDATE files SET taken_at = '2025-07-01T09:45:00Z' WHERE id = $1", [id]); // как у файла, загруженного старой версией
      const waitDone = async () => { assert.ok(await wait(async () => !(await intCall('GET', '/internal/media/dates')).job.running, 30_000)); return (await intCall('GET', '/internal/media/dates')).job; };
      const check = await intCall('POST', '/internal/media/dates', { apply: false });
      assert.equal(check.job.apply, false);
      const done = await waitDone();
      assert.ok(done.changed >= 1 && done.checked >= 1);
      assert.ok(done.examples.some((x: any) => x.name === 'PXL_20170809_101112.jpg' && x.after === '2017-08-09T10:11:12.000Z'));
      assert.equal(await takenOf(), '2025-07-01T09:45:00.000Z', 'проверка ничего не меняет');
      await intCall('POST', '/internal/media/dates', { apply: true });
      await waitDone();
      assert.equal(await takenOf(), '2017-08-09T10:11:12.000Z');
      const bad = await fetch(`${e.intBase}/internal/media/dates`, { method: 'POST', headers: { authorization: `Bearer ${e.token}`, 'content-type': 'application/json' }, body: JSON.stringify({}) });
      assert.equal(bad.status, 400);
    } finally {
      await c.end();
    }
  });

  it('очистка миниатюр удаляет их с диска, они строятся заново', async () => {
    const img = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#cc6633' } }).jpeg().toBuffer();
    const id = (await upload(e.boris, 'small.jpg', img)).json.file.id;
    assert.equal((await api('GET', `/api/files/${id}/thumb`, { cookie: e.boris })).status, 200);
    assert.ok((await intCall('GET', '/internal/media')).thumbs.files >= 1);
    const c = await intCall('POST', '/internal/media/clear', { what: 'thumbs' });
    assert.ok(c.files >= 1);
    assert.equal((await intCall('GET', '/internal/media')).thumbs.files, 0);
    assert.equal((await api('GET', `/api/files/${id}/thumb`, { cookie: e.boris })).status, 200);
  });

  it('копия видео: делается в фоне, отдаётся на /view, меньше оригинала; смена настроек стирает; выключение даёт 404', { skip: !hasFfmpeg && 'нет ffmpeg' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dvc-media-'));
    try {
      const src = join(dir, 's.mp4');
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=3', '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', src]);
      const orig = await readFile(src);
      const id = (await upload(e.anna, 'clip.mp4', orig)).json.file.id;
      assert.equal((await api('GET', `/api/files/${id}/view`, { cookie: e.anna })).status, 404, 'пока выключено, копии нет');

      assert.equal((await patch({ videoEnabled: true, videoHeight: 480, videoCrf: 32 })).status, 200);
      assert.ok(await wait(async () => (await api('GET', `/api/files/${id}/view`, { cookie: e.anna })).status === 200), 'копия не появилась');
      const v = await api('GET', `/api/files/${id}/view`, { cookie: e.anna });
      assert.equal(v.headers.get('content-type'), 'video/mp4');
      assert.ok(v.buf.length < orig.length, `копия ${v.buf.length} Б должна быть меньше оригинала ${orig.length} Б`);
      const out = join(dir, 'c.mp4');
      await import('node:fs/promises').then((m) => m.writeFile(out, v.buf));
      const h = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'csv=p=0', out]).toString().trim();
      assert.equal(h, '480');
      const o = await intCall('GET', '/internal/media');
      assert.equal(o.videos.ready, 1);
      assert.equal(o.videos.pending, 0);
      assert.ok(o.videos.copies.bytes > 0);
      assert.equal((await api('GET', `/api/files/${id}/view`, { cookie: e.boris })).status, 404, 'чужое видео недоступно');
      assert.equal((await api('GET', `/api/files/${id}`, { cookie: e.anna })).buf.length, orig.length, 'оригинал цел');

      // смена высоты: старая копия стёрта, фон делает новую
      const r = await patch({ videoHeight: 720 });
      assert.deepEqual(((await r.json()) as any).cleared, ['videos']);
      assert.ok(await wait(async () => (await intCall('GET', '/internal/media')).videos.ready === 1));

      assert.equal((await patch({ videoEnabled: false })).status, 200);
      await new Promise((r2) => setTimeout(r2, 2500)); // кэш настроек на публичном порту живёт пару секунд
      assert.equal((await api('GET', `/api/files/${id}/view`, { cookie: e.anna })).status, 404);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('очередь копий: открытый ролик первым, остальные от новых к старым; «непростой» оригинал всегда получает копию', { skip: !hasFfmpeg && 'нет ffmpeg' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dvc-media-'));
    const c = new Client({ connectionString: e.dbUrl });
    await c.connect();
    try {
      assert.equal((await patch({ videoEnabled: false })).status, 200);
      await new Promise((r2) => setTimeout(r2, 2500));
      const mk = (name: string, size: string, crf: string, pix: string) => {
        const f = join(dir, name);
        execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=25:duration=1`, '-c:v', 'libx264', '-crf', crf, '-pix_fmt', pix, f]);
        return readFile(f);
      };
      const ids: Record<string, string> = {};
      // три разных ролика в порядке загрузки: q-old, q-mid, q-new; ещё один «полнодиапазонный» (yuvj420p) очень сжатый
      for (const [name, size, crf, pix] of [['q-old.mp4', '640x360', '23', 'yuv420p'], ['q-mid.mp4', '640x360', '24', 'yuv420p'], ['q-new.mp4', '640x360', '25', 'yuv420p']] as const) {
        ids[name] = (await upload(e.anna, name, await mk(name, size, crf, pix))).json.file.id;
      }
      ids['q-jpeg.mp4'] = (await upload(e.anna, 'q-jpeg.mp4', await mk('q-jpeg.mp4', '320x240', '51', 'yuvj420p'))).json.file.id;
      // человек открыл самый старый, копии нет: он встаёт в начало очереди
      assert.equal((await api('GET', `/api/files/${ids['q-old.mp4']}/view`, { cookie: e.anna })).status, 404);
      assert.equal((await patch({ videoEnabled: true, videoHeight: 480, videoCrf: 32 })).status, 200);
      const done = async () => Number((await c.query("SELECT count(*) AS n FROM video_copies v JOIN files f ON f.blob_id = v.blob_id WHERE f.original_name LIKE 'q-%'")).rows[0].n) === 4;
      const end = Date.now() + 60_000;
      while (!(await done()) && Date.now() < end) await new Promise((r2) => setTimeout(r2, 300));
      assert.ok(await done(), 'копии не появились');
      const order = (await c.query("SELECT f.original_name AS n, v.status AS s FROM video_copies v JOIN files f ON f.blob_id = v.blob_id WHERE f.original_name LIKE 'q-%' ORDER BY v.updated_at, f.id")).rows;
      assert.equal(order[0].n, 'q-old.mp4', 'открытый ролик должен быть первым');
      // дальше от новых к старым: самый новый по загрузке (q-jpeg), затем q-new, затем q-mid
      assert.deepEqual(order.slice(1).map((r: { n: string }) => r.n), ['q-jpeg.mp4', 'q-new.mp4', 'q-mid.mp4']);
      // «полнодиапазонный» оригинал: копия больше оригинала, но остаётся (раньше такой ролик оставался без копии)
      assert.equal(order.find((r: { n: string }) => r.n === 'q-jpeg.mp4').s, 'ready');
      assert.equal((await api('GET', `/api/files/${ids['q-jpeg.mp4']}/view`, { cookie: e.anna })).status, 200);
    } finally {
      await c.end();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
