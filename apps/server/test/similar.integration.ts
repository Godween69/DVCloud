// Поиск похожих на настоящем Postgres и диске: загрузка, отпечатки в фоне, дубликаты, серии, чужие файлы, корзина. Запуск: npm run test:db
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { startEnv } from './helpers/filesenv';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
// Сцена из мягких цветных пятен (shift двигает камеру, gain меняет яркость)
function scene(seed: number, w: number, h: number, shift = 0, gain = 1): Buffer {
  const r = rng(seed);
  const blobs = Array.from({ length: 12 }, () => ({ x: r() * w, y: r() * h, rad: 40 + r() * 140, c: [r() * 255, r() * 255, r() * 255] }));
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let ws = 0;
      const acc = [0, 0, 0];
      for (const b of blobs) {
        const k = Math.exp(-((x + shift - b.x) ** 2 + (y - b.y) ** 2) / (2 * b.rad * b.rad));
        ws += k;
        for (let c = 0; c < 3; c++) acc[c] += k * b.c[c];
      }
      const edge = ((Math.floor((x + shift) / 30) + Math.floor(y / 30)) & 1) * 14;
      for (let c = 0; c < 3; c++) buf[(y * w + x) * 3 + c] = Math.max(0, Math.min(255, Math.round((acc[c] / (ws + 1e-6)) * gain + edge)));
    }
  return buf;
}
const img = (raw: Buffer, w: number, h: number) => sharp(raw, { raw: { width: w, height: h, channels: 3 } });
const W = 800;
const H = 600;

describe('похожие фото (настоящий Postgres и диск)', () => {
  const e = startEnv();
  const { api, upload } = e;
  const ids: Record<string, string> = {};
  before(async () => {
    await e.start();
    const A = scene(11, W, H);
    const up = async (cookie: string, name: string, s: ReturnType<typeof sharp>, modified: string) => {
      const r = await upload(cookie, name, await s.jpeg({ quality: 88 }).toBuffer(), modified);
      assert.equal(r.status, 201, JSON.stringify(r.json));
      ids[name] = r.json.file.id;
    };
    await up(e.anna, 'orig.jpg', img(A, W, H), '2026-05-01T10:00:00Z');
    await up(e.anna, 'whatsapp.jpg', img(A, W, H).resize(400, 300).jpeg({ quality: 40 }), '2026-05-03T10:00:00Z');
    await up(e.anna, 'other.jpg', img(scene(33, W, H), W, H), '2026-05-05T10:00:00Z');
    for (let i = 0; i < 4; i++) await up(e.anna, `burst${i}.jpg`, img(scene(44, W, H, i * 10, 1 + i * 0.02), W, H), `2026-05-10T10:00:0${i}Z`);
    const bo = await upload(e.boris, 'orig.jpg', await img(A, W, H).jpeg({ quality: 88 }).toBuffer(), '2026-05-01T10:00:00Z'); // у другого человека тот же снимок: к Анне не относится
    assert.equal(bo.status, 201);
  });
  after(async () => { await e.stop(); });

  // Отпечатки считаются в фоне: ждём, пока обработаны все фото (до 20 секунд).
  async function ready(cookie: string, kind: 'duplicates' | 'series') {
    for (let i = 0; i < 100; i++) {
      const r = await api('GET', `/api/similar/${kind}`, { cookie });
      assert.equal(r.status, 200);
      if (r.json.ready === r.json.images) return r.json;
      await new Promise((ok) => setTimeout(ok, 200));
    }
    throw new Error('отпечатки не успели посчитаться');
  }

  it('без входа 401', async () => {
    assert.equal((await api('GET', '/api/similar/duplicates')).status, 401);
    assert.equal((await api('GET', '/api/similar/series')).status, 401);
  });

  it('дубликаты: оригинал и копия из WhatsApp, оригинал первым и оставить, копию предложено убрать', async () => {
    const j = await ready(e.anna, 'duplicates');
    assert.equal(j.groups.length, 1);
    const [keep, drop] = j.groups[0].files;
    assert.equal(keep.id, ids['orig.jpg']);
    assert.equal(keep.suggestRemove, false);
    assert.equal(drop.id, ids['whatsapp.jpg']);
    assert.equal(drop.suggestRemove, true);
    assert.equal(keep.width, W);
    assert.equal(drop.width, 400);
  });

  it('серии: четыре кадра подряд в одной группе, лучший первым', async () => {
    const j = await ready(e.anna, 'series');
    assert.equal(j.groups.length, 1);
    const g = j.groups[0].files;
    assert.equal(g.length, 4);
    assert.deepEqual(g.map((f: { id: string }) => f.id).sort(), [0, 1, 2, 3].map((i) => ids[`burst${i}.jpg`]).sort());
    assert.equal(g.filter((f: { suggestRemove: boolean }) => !f.suggestRemove).length, 1);
  });

  it('чужой снимок не попадает к другому человеку, ответы без путей на диске', async () => {
    const j = await ready(e.boris, 'duplicates');
    assert.equal(j.groups.length, 0);
    const a = await ready(e.anna, 'duplicates');
    assert.ok(!JSON.stringify(a).includes('library/'));
  });

  it('после удаления копии в корзину группа исчезает', async () => {
    const d = await api('DELETE', `/api/files/${ids['whatsapp.jpg']}`, { cookie: e.anna });
    assert.equal(d.status, 200);
    const j = await ready(e.anna, 'duplicates');
    assert.equal(j.groups.length, 0);
  });
});
