// HEIC: определение по заголовку и разбор в JPEG. Разбор проверяется только там, где есть libheif-tools (в образе сервера он ставится).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { brandsAreHeic, decodeHeic, isHeicFile } from '../src/files/heic';
import { TINY_HEIC } from './helpers/heic-fixture';


function hasHeifTool(): boolean {
  for (const c of ['heif-dec', 'heif-convert']) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return true; // программа есть, просто иначе отвечает на --version
    }
  }
  return false;
}

function head(major: string, compat: string[] = []): Buffer {
  const size = 16 + compat.length * 4;
  const b = Buffer.alloc(size);
  b.writeUInt32BE(size, 0);
  b.write('ftyp', 4, 'latin1');
  b.write(major, 8, 'latin1');
  compat.forEach((c, i) => b.write(c, 16 + i * 4, 'latin1'));
  return b;
}

describe('HEIC', () => {
  it('узнаётся по заголовку, а не по имени', () => {
    assert.equal(brandsAreHeic(head('heic')), true);
    assert.equal(brandsAreHeic(head('heix')), true);
    assert.equal(brandsAreHeic(head('mif1', ['mif1', 'heic'])), true, 'общая марка с heic среди совместимых');
    assert.equal(brandsAreHeic(head('mif1', ['mif1', 'avif'])), false, 'AVIF читает sharp сам');
    assert.equal(brandsAreHeic(head('avif')), false);
    assert.equal(brandsAreHeic(head('isom')), false, 'видео mp4');
    assert.equal(brandsAreHeic(Buffer.from('\xff\xd8\xff\xe0 jpeg')), false);
    assert.equal(brandsAreHeic(Buffer.alloc(0)), false);
  });

  it('настоящий файл распознаётся и разбирается в JPEG нужного размера', { skip: !hasHeifTool() && 'нет libheif-tools' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'heic-test-'));
    try {
      const p = join(dir, 'a.heic');
      await writeFile(p, TINY_HEIC);
      assert.equal(await isHeicFile(p), true);
      const jpeg = await decodeHeic(p);
      const m = await sharp(jpeg).metadata();
      assert.equal(m.format, 'jpeg');
      assert.equal(m.width, 96);
      assert.equal(m.height, 64);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('битый файл даёт ошибку, а не зависание', { skip: !hasHeifTool() && 'нет libheif-tools' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'heic-test-'));
    try {
      const p = join(dir, 'b.heic');
      await writeFile(p, Buffer.concat([head('heic'), Buffer.from('мусор')]));
      await assert.rejects(decodeHeic(p));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
