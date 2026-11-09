// Дубликаты по всему хранилищу (админ): поиск и слияние на настоящем Postgres и диске. Запуск: npm run test:db
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { Client } from 'pg';
import { startEnv } from './helpers/filesenv';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
function scene(seed: number, w: number, h: number): Buffer {
  const r = rng(seed);
  const blobs = Array.from({ length: 12 }, () => ({ x: r() * w, y: r() * h, rad: 40 + r() * 140, c: [r() * 255, r() * 255, r() * 255] }));
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let ws = 0;
      const acc = [0, 0, 0];
      for (const b of blobs) {
        const k = Math.exp(-((x - b.x) ** 2 + (y - b.y) ** 2) / (2 * b.rad * b.rad));
        ws += k;
        for (let c = 0; c < 3; c++) acc[c] += k * b.c[c];
      }
      const edge = ((Math.floor(x / 30) + Math.floor(y / 30)) & 1) * 14;
      for (let c = 0; c < 3; c++) buf[(y * w + x) * 3 + c] = Math.max(0, Math.min(255, Math.round(acc[c] / (ws + 1e-6) + edge)));
    }
  return buf;
}
const img = (raw: Buffer, w: number, h: number) => sharp(raw, { raw: { width: w, height: h, channels: 3 } });
const W = 800;
const H = 600;
const J = { type: 'application/json' };
const body = (o: unknown) => JSON.stringify(o);
const exists = (p: string) => access(p).then(() => true, () => false);

describe('дубликаты по всему хранилищу (настоящий Postgres и диск)', () => {
  const e = startEnv();
  const { api, upload } = e;
  const f: Record<string, string> = {};
  const ic = async (method: string, path: string, data?: unknown) => {
    const r = await fetch(e.intBase + path, { method, headers: { authorization: `Bearer ${e.token}`, ...(data !== undefined ? { 'content-type': 'application/json' } : {}) }, body: data !== undefined ? JSON.stringify(data) : undefined });
    let json: any = null;
    try { json = await r.json(); } catch { /* пусто */ }
    return { status: r.status, json };
  };
  // Ждём, пока фон посчитает отпечатки и найдёт группы.
  async function found(minGroups: number, minBlobs = 0) {
    let last: unknown = null;
    for (let i = 0; i < 120; i++) {
      await ic('POST', '/internal/duplicates/scan', {});
      await new Promise((ok) => setTimeout(ok, 300));
      const r = (await ic('GET', '/internal/duplicates')).json;
      last = r;
      if (!r.scanning && r.totalGroups >= minGroups && (r.groups[0]?.blobs.length ?? minBlobs) >= minBlobs) return r;
    }
    throw new Error('дубликаты не нашлись за отведённое время: ' + JSON.stringify(last));
  }

  before(async () => {
    await e.start({ DVCLOUD_FP_TICK_MS: '200', DVCLOUD_NO_DUP_SCAN: '1' });
    const A = scene(11, W, H);
    const up = async (cookie: string, name: string, s: ReturnType<typeof sharp>, key: string) => {
      const r = await upload(cookie, name, await s.toBuffer(), '2026-05-01T10:00:00Z');
      assert.equal(r.status, 201, JSON.stringify(r.json));
      f[key] = r.json.file.id;
    };
    await up(e.anna, 'orig.jpg', img(A, W, H).jpeg({ quality: 88 }), 'annaOrig');
    await up(e.anna, 'wa.jpg', img(A, W, H).resize(400, 300).jpeg({ quality: 40 }), 'annaWa');
    await up(e.boris, 'wa-boris.jpg', img(A, W, H).resize(400, 300).jpeg({ quality: 38 }), 'borisWa');
    await up(e.anna, 'other.jpg', img(scene(33, W, H), W, H).jpeg({ quality: 88 }), 'other');
    const al = (await api('POST', '/api/albums', { cookie: e.anna, body: body({ name: 'Поездка' }), ...J })).json.album.id;
    f.album = al;
    await api('POST', `/api/albums/${al}/add`, { cookie: e.anna, body: body({ ids: [f.annaWa] }), ...J });
  });
  after(async () => { await e.stop(); });

  it('без токена админки недоступно', async () => {
    const r = await fetch(e.intBase + '/internal/duplicates');
    assert.ok(r.status === 401 || r.status === 403);
  });

  it('фон находит одну группу из трёх файлов-оригиналов; лучший (больше пикселей) отмечен «оставить»; чужие и разные не входят', async () => {
    const rep = await found(1, 3);
    assert.equal(rep.totalGroups, 1);
    const g = rep.groups[0];
    assert.equal(g.blobs.length, 3);
    assert.equal(g.blobs[0].keep, true);
    assert.equal(g.blobs[0].width, W);
    assert.ok(g.blobs.slice(1).every((b: any) => !b.keep && b.width === 400));
    assert.ok(g.reclaimBytes > 0 && rep.reclaimBytes === g.reclaimBytes);
    const owners = g.blobs.flatMap((b: any) => b.owners.map((o: any) => o.login)).sort();
    assert.deepEqual(owners, ['anna', 'anna', 'boris']);
  });

  it('слияние: чужих и несвязанных файлов не принимает', async () => {
    const rep = (await ic('GET', '/internal/duplicates')).json;
    const keep = rep.groups[0].blobs[0].blobId;
    const drop = rep.groups[0].blobs[1].blobId;
    assert.equal((await ic('POST', '/internal/duplicates/merge', { keep, drop: [keep] })).status, 400, 'сам в себя нельзя');
    assert.equal((await ic('POST', '/internal/duplicates/merge', { keep, drop: [] })).status, 400);
    assert.equal((await ic('POST', '/internal/duplicates/merge', { keep, drop: ['abc'] })).status, 400);
    const c = new Client({ connectionString: e.dbUrl });
    await c.connect();
    const otherBlob = (await c.query('SELECT blob_id FROM files WHERE id = $1', [f.other])).rows[0].blob_id as string;
    await c.end();
    assert.equal((await ic('POST', '/internal/duplicates/merge', { keep, drop: [otherBlob] })).status, 409, 'непохожий файл слить нельзя');
    assert.ok(drop);
  });

  it('слияние: у Анны запись на копию убрана, её альбом перешёл на оригинал; у Бориса запись переключена на оригинал; лишние файлы стёрты с диска', async () => {
    const rep = (await ic('GET', '/internal/duplicates')).json;
    const [best, ...rest] = rep.groups[0].blobs;
    const originals = async () => (await e.walk(e.dataDir)).filter((p) => /\.jpe?g$/i.test(p) && !/\/(thumbs|previews|faces)\//.test(p)).length;
    const filesBefore = await originals();
    assert.equal(rest.length, 2);
    const r = await ic('POST', '/internal/duplicates/merge', { keep: best.blobId, drop: rest.map((b: any) => b.blobId) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.removedFiles, 1, 'запись Анны на копию убрана (оригинал у неё уже был)');
    assert.equal(r.json.merged, 1, 'запись Бориса переключена');
    // Анна: копии нет в библиотеке, оригинал на месте и лежит в альбоме «Поездка»
    assert.equal((await api('GET', `/api/files/${f.annaWa}`, { cookie: e.anna })).status, 404);
    assert.equal((await api('GET', `/api/files/${f.annaOrig}`, { cookie: e.anna })).status, 200);
    const inAlbum = (await api('GET', `/api/albums/${f.album}/files`, { cookie: e.anna })).json.files.map((x: any) => x.id);
    assert.deepEqual(inAlbum, [f.annaOrig], 'альбом не потерял фото, теперь там оригинал');
    // Борис: его файл теперь отдаёт оригинал (тот же размер, что у лучшего), имя и дата его
    const b = await api('GET', `/api/files/${f.borisWa}`, { cookie: e.boris });
    assert.equal(b.status, 200);
    assert.equal((await sharp(b.buf).metadata()).width, W);
    const meta = (await api('GET', '/api/files', { cookie: e.boris })).json.files.find((x: any) => x.id === f.borisWa);
    assert.equal(meta.name, 'wa-boris.jpg', 'имя файла у человека сохранилось');
    assert.equal(meta.size, b.buf.length, 'размер записи соответствует тому, что реально лежит');
    // На диске остался один файл-оригинал из трёх
    assert.equal(await originals(), filesBefore - 2, 'два лишних файла стёрты с диска, остались оригинал и посторонний снимок');
    assert.equal(await exists(join(e.dataDir, 'thumbs', `${rest[0].blobId}.webp`)), false);
  });

  it('после слияния групп больше нет, повторное слияние отклоняется', async () => {
    const rep = await found(0);
    assert.equal(rep.totalGroups, 0);
    assert.equal((await ic('POST', '/internal/duplicates/merge', { keep: '999999', drop: ['999998'] })).status, 409);
  });
});
