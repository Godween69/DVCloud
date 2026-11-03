import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import sharp from 'sharp';
import { FingerprintService } from '../src/files/fingerprint.service';
import { DEFAULT_DUP, DEFAULT_SERIES, Item, findDuplicates, findSeries, hamming, rankForQuality, rankForSeries, tinyDiff } from '../src/files/similar';

// Детерминированный генератор случайных чисел (чтобы тест не «плавал»).
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

// «Фотография» из мягких цветных пятен и мелких деталей: у неё есть и крупная структура, и текстура.
function scene(seed: number, w: number, h: number, shift = 0, gain = 1, noise = 0): Buffer {
  const r = rng(seed);
  const blobs = Array.from({ length: 14 }, () => ({ x: r() * w, y: r() * h, rad: 80 + r() * 260, c: [r() * 255, r() * 255, r() * 255] }));
  const rn = rng(seed * 7 + 1);
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let wsum = 0;
      const acc = [0, 0, 0];
      for (const b of blobs) {
        const dx = x + shift - b.x;
        const dy = y - b.y;
        const k = Math.exp(-(dx * dx + dy * dy) / (2 * b.rad * b.rad));
        wsum += k;
        for (let c = 0; c < 3; c++) acc[c] += k * b.c[c];
      }
      const edge = ((Math.floor((x + shift) / 40) + Math.floor(y / 40)) & 1) * 14; // «шахматка» для чёткости
      for (let c = 0; c < 3; c++) {
        const v = (acc[c] / (wsum + 1e-6)) * gain + edge + (noise ? (rn() - 0.5) * noise : 0);
        buf[(y * w + x) * 3 + c] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
  }
  return buf;
}
const png = (raw: Buffer, w: number, h: number) => sharp(raw, { raw: { width: w, height: h, channels: 3 } });

describe('поиск похожих фото', () => {
  let dir = '';
  const items: Record<string, Item> = {};
  const svc = new FingerprintService(null as never, null as never);
  let n = 0;
  async function add(name: string, img: ReturnType<typeof sharp>, takenAt: number, size?: number) {
    const path = join(dir, `${name}.jpg`);
    await img.toFile(path);
    const fp = await svc.compute(path);
    items[name] = { id: String(++n), ...fp, size: size ?? 1, takenAt };
  }

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dvc-sim-'));
    const W = 1600;
    const H = 1200;
    const t0 = Date.UTC(2026, 5, 1, 12, 0, 0);
    const A = scene(11, W, H);
    // A: оригинал; A_wa: как из WhatsApp (меньше и сильно пережато); A_png: тот же снимок без потерь
    await add('A', png(A, W, H).jpeg({ quality: 92 }), t0);
    await add('A_wa', png(A, W, H).resize(800, 600).jpeg({ quality: 45 }), t0 + 86_400_000);
    // B: снимок, повёрнутый на 90 градусов с меткой EXIF (телефон хранит боком); B_plain: тот же без поворота
    const B = scene(22, W, H);
    await add('B_plain', png(B, W, H).jpeg({ quality: 90 }), t0 + 5 * 86_400_000);
    await add('B_exif', png(B, W, H).rotate(-90).jpeg({ quality: 90 }).withMetadata({ orientation: 6 }), t0 + 6 * 86_400_000);
    // C: совсем другой снимок
    await add('C', png(scene(33, W, H), W, H).jpeg({ quality: 90 }), t0 + 9 * 86_400_000);
    // Серия S: одна сцена, камера чуть сдвигается, яркость плавает, есть шум; снято за несколько секунд
    const ts = t0 + 20 * 86_400_000;
    for (let i = 0; i < 5; i++) await add(`S${i}`, png(scene(44, W, H, i * 12, 1 + (i - 2) * 0.03, 6), W, H).jpeg({ quality: 88 }), ts + i * 1500);
    // D: другая сцена в то же время (не должна попасть в серию S); E: сцена S, но снятая через час (другая серия по времени)
    await add('D', png(scene(55, W, H), W, H).jpeg({ quality: 88 }), ts + 8000);
    await add('E', png(scene(44, W, H, 30, 1, 6), W, H).jpeg({ quality: 88 }), ts + 3_600_000);
  });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it('печатает расстояния (для настройки порогов)', () => {
    const d = (a: string, b: string) => `${a}~${b}: бит ${hamming(items[a].dhash, items[b].dhash)}, цвет ${tinyDiff(items[a].tiny, items[b].tiny).toFixed(1)}`;
    console.log([d('A', 'A_wa'), d('B_plain', 'B_exif'), d('A', 'C'), d('A', 'B_plain'), d('S0', 'S1'), d('S0', 'S4'), d('S0', 'D'), d('S0', 'E')].join('\n'));
  });

  it('дубликаты: тот же снимок в худшем качестве и снимок с меткой поворота найдены, чужие нет', () => {
    const g = findDuplicates(Object.values(items), DEFAULT_DUP).map((x) => x.map((i) => i.id).sort().join(','));
    const id = (k: string) => items[k].id;
    assert.ok(g.includes([id('A'), id('A_wa')].sort().join(',')), `A и A_wa: ${g.join(' | ')}`);
    assert.ok(g.includes([id('B_plain'), id('B_exif')].sort().join(',')), `B и B_exif: ${g.join(' | ')}`);
    assert.ok(!g.some((x) => x.includes(id('C'))), 'C ни с кем не совпадает');
  });

  it('какую копию оставить: больше пикселей, потом больше файл', () => {
    const g = findDuplicates(Object.values(items), DEFAULT_DUP).find((x) => x.some((i) => i.id === items.A.id))!;
    assert.equal(rankForQuality(g)[0].id, items.A.id);
  });

  it('серия: пять подряд снятых кадров вместе; другая сцена и кадр через час отдельно', () => {
    const g = findSeries(Object.values(items), DEFAULT_SERIES).map((x) => x.map((i) => i.id).sort().join(','));
    const S = [0, 1, 2, 3, 4].map((i) => items[`S${i}`].id).sort().join(',');
    assert.ok(g.includes(S), `серия S: ${g.join(' | ')}`);
    assert.equal(g.length, 1, `лишних серий нет: ${g.join(' | ')}`);
    const grp = findSeries(Object.values(items), DEFAULT_SERIES)[0];
    const { ranked, keep } = rankForSeries(grp);
    assert.equal(ranked.length, 5);
    assert.equal(keep, 1);
  });
});
