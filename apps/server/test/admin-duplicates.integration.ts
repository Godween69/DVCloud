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
    // страницы: за пределами списка групп нет, но общее число и смещение сообщаются
    const past = (await ic('GET', '/internal/duplicates?offset=1&limit=50')).json;
    assert.equal(past.groups.length, 0);
    assert.equal(past.offset, 1);
    assert.equal(past.totalGroups, 1);
    assert.equal((await ic('GET', '/internal/duplicates?offset=0&limit=1')).json.groups.length, 1);
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

describe('решения по группам дубликатов (настоящий Postgres и диск)', () => {
  const e = startEnv();
  const { upload } = e;
  const f: Record<string, string> = {};
  const ic = async (method: string, path: string, data?: unknown) => {
    const r = await fetch(e.intBase + path, { method, headers: { authorization: `Bearer ${e.token}`, ...(data !== undefined ? { 'content-type': 'application/json' } : {}) }, body: data !== undefined ? JSON.stringify(data) : undefined });
    let json: any = null;
    try { json = await r.json(); } catch { /* пусто */ }
    return { status: r.status, json };
  };

  before(async () => {
    await e.start({ DVCLOUD_FP_TICK_MS: '200', DVCLOUD_NO_DUP_SCAN: '1' });
    // Три независимые группы: у каждой оригинал и уменьшенная копия
    for (const [key, seed] of [['a', 11], ['b', 77], ['c', 123]] as const) {
      const S = scene(seed, W, H);
      const o = await upload(e.anna, `${key}-orig.jpg`, await img(S, W, H).jpeg({ quality: 88 }).toBuffer(), '2026-05-01T10:00:00Z');
      const c = await upload(e.anna, `${key}-copy.jpg`, await img(S, W, H).resize(400, 300).jpeg({ quality: 40 }).toBuffer(), '2026-05-01T10:00:00Z');
      assert.equal(o.status, 201); assert.equal(c.status, 201);
      f[`${key}Orig`] = o.json.file.id;
      f[`${key}Copy`] = c.json.file.id;
    }
  });
  after(async () => { await e.stop(); });

  async function found(groups: number) {
    let last: unknown = null;
    for (let i = 0; i < 120; i++) {
      await ic('POST', '/internal/duplicates/scan', {});
      await new Promise((ok) => setTimeout(ok, 300));
      const r = (await ic('GET', '/internal/duplicates')).json;
      last = r;
      if (!r.scanning && r.totalGroups === groups) return r;
    }
    throw new Error('группы не нашлись: ' + JSON.stringify(last));
  }
  async function finished() {
    let rep: any = null;
    for (let i = 0; i < 200; i++) {
      rep = (await ic('GET', '/internal/duplicates')).json;
      if (!rep.bulk.running && rep.bulk.finishedAt) break;
      await new Promise((ok) => setTimeout(ok, 200));
    }
    return rep;
  }

  it('плохие решения отклоняются, ничего не стирается', async () => {
    const rep = await found(3);
    const g = rep.groups[0];
    assert.equal((await ic('POST', '/internal/duplicates/apply', {})).status, 400);
    assert.equal((await ic('POST', '/internal/duplicates/apply', { decisions: [] })).status, 400);
    assert.equal((await ic('POST', '/internal/duplicates/apply', { decisions: [{ group: '999999', keep: [] }] })).status, 409, 'группы нет в списке');
    assert.equal((await ic('POST', '/internal/duplicates/apply', { decisions: [{ group: g.id, keep: ['999999'] }] })).status, 409, 'чужой файл');
    assert.equal((await ic('POST', '/internal/duplicates/apply', { decisions: [{ group: g.id, keep: [] }, { group: g.id, keep: [] }] })).status, 400, 'группа дважды');
    assert.equal((await ic('GET', '/internal/duplicates')).json.totalGroups, 3, 'всё на месте');
  });

  it('группа без отмеченных пропускается, у группы с одним отмеченным лишнее стирается', async () => {
    const rep = await found(3);
    const [g1, g2] = rep.groups;
    const best = g1.blobs.find((b: any) => b.keep).blobId;
    const r = await ic('POST', '/internal/duplicates/apply', { decisions: [{ group: g1.id, keep: [best] }, { group: g2.id, keep: [] }] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.started, 2);
    const done = await finished();
    assert.equal(done.bulk.total, 2);
    assert.equal(done.bulk.failed, 1, 'пустая группа пропущена');
    assert.ok(done.bulk.bytes > 0, 'место освобождено');
    const after = await found(2);
    assert.equal(after.totalGroups, 2);
  });

  it('оба оставлены: лишнего нет, но пара больше не предлагается как дубликаты', async () => {
    const rep = await found(2);
    const g = rep.groups[0];
    const both = g.blobs.map((b: any) => b.blobId);
    const r = await ic('POST', '/internal/duplicates/apply', { decisions: [{ group: g.id, keep: both }] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const done = await finished();
    assert.equal(done.bulk.failed, 0);
    const after = await found(1);
    assert.equal(after.totalGroups, 1, 'оставленная пара из списка ушла, осталась только непросмотренная группа');
    // оба файла на месте
    const ids = [f.aOrig, f.aCopy, f.bOrig, f.bCopy, f.cOrig, f.cCopy];
    let alive = 0;
    for (const id of ids) if ((await e.api('GET', `/api/files/${id}`, { cookie: e.anna })).status === 200) alive++;
    assert.ok(alive >= 4, `живых файлов ${alive}`);
  });

  it('оставлены двое, а третий связан с ними только через второго: группа не пропускается зря', async () => {
    const S = scene(201, W, H);
    const ids: string[] = [];
    for (const [n, q, w] of [['ch-a.jpg', 90, 800], ['ch-b.jpg', 60, 600], ['ch-c.jpg', 40, 400]] as const) {
      const r = await upload(e.anna, n, await img(S, W, H).resize(w, Math.round((w * H) / W)).jpeg({ quality: q }).toBuffer(), '2026-05-02T10:00:00Z');
      assert.equal(r.status, 201, JSON.stringify(r.json));
      ids.push(r.json.file.id);
    }
    // ждём, пока посчитаются отпечатки всех трёх
    const c = new Client({ connectionString: e.dbUrl });
    await c.connect();
    try {
      for (let i = 0; i < 100; i++) {
        const n = Number((await c.query('SELECT count(*) AS n FROM file_fingerprints WHERE file_id = ANY($1::bigint[])', [ids])).rows[0].n);
        if (n === 3) break;
        await new Promise((ok) => setTimeout(ok, 200));
      }
      // цепочка: a~b (3 бита), b~c (3 бита), a и c различаются на 6 бит, напрямую не связаны
      const base = Buffer.from((await c.query('SELECT dhash FROM file_fingerprints WHERE file_id = $1', [ids[0]])).rows[0].dhash as Buffer);
      const flip = (b: Buffer, bits: number[]) => { const o = Buffer.from(b); for (const k of bits) o[k >> 3] ^= 1 << (k & 7); return o; };
      await c.query('UPDATE file_fingerprints SET dhash = $2 WHERE file_id = $1', [ids[0], base]);
      await c.query('UPDATE file_fingerprints SET dhash = $2 WHERE file_id = $1', [ids[1], flip(base, [0, 1, 2])]);
      await c.query('UPDATE file_fingerprints SET dhash = $2 WHERE file_id = $1', [ids[2], flip(base, [0, 1, 2, 3, 4, 5])]);
      await c.query('UPDATE file_fingerprints SET tiny = (SELECT tiny FROM file_fingerprints WHERE file_id = $1) WHERE file_id = ANY($2::bigint[])', [ids[0], ids]);
    } finally { await c.end(); }
    let g: any = null;
    for (let i = 0; i < 100 && !g; i++) {
      await ic('POST', '/internal/duplicates/scan', {});
      await new Promise((ok) => setTimeout(ok, 300));
      const rep = (await ic('GET', '/internal/duplicates')).json;
      if (!rep.scanning) g = rep.groups.find((x: any) => x.blobs.length === 3);
    }
    assert.ok(g, 'группа из трёх найдена');
    const byFile = new Map<string, string>(g.blobs.map((b: any) => [b.fileId, b.blobId]));
    // оставляем двух ближних к началу цепочки (a и b), стираем c, которая связана только с b
    const keep = [byFile.get(ids[0])!, byFile.get(ids[1])!];
    const r = await ic('POST', '/internal/duplicates/apply', { decisions: [{ group: g.id, keep }] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const done = await finished();
    assert.equal(done.bulk.failed, 0, JSON.stringify(done.bulk.problems));
    assert.ok(done.bulk.bytes > 0, 'третий файл стёрт');
  });
});
