import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, createWriteStream, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { zipSize, zipStream, ZipEntry } from '../src/files/zip';

const mem = (name: string, data: Buffer): ZipEntry => ({
  name,
  size: data.length,
  mtime: new Date('2026-05-10T12:00:00Z'),
  open: async function* () {
    for (let i = 0; i < data.length; i += 7) yield data.subarray(i, i + 7);
  },
});

// unzip есть не везде (на чистой Ubuntu его может не быть): тогда проверяем одним Python.
const HAS_UNZIP = spawnSync('unzip', ['-v']).status === 0;

const PY = `
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
print(len(z.namelist()), bad)
for n in z.namelist()[:3]: print(n, len(z.read(n)))
`;

async function build(entries: ZipEntry[]): Promise<{ file: string; dir: string; bytes: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'zip-'));
  const file = join(dir, 'a.zip');
  await pipeline(Readable.from(zipStream(entries)), createWriteStream(file));
  return { file, dir, bytes: statSync(file).size };
}

test('архив читается python и unzip, размер известен заранее, имена в UTF-8', async () => {
  const entries = [mem('фото 1.jpg', Buffer.from('привет, мир'.repeat(50))), mem('b.jpg', Buffer.from('x')), mem('пусто.jpg', Buffer.alloc(0))];
  const { file, dir, bytes } = await build(entries);
  try {
    assert.equal(bytes, zipSize(entries));
    const py = spawnSync('python3', ['-I', '-c', PY, file], { encoding: 'utf8' });
    assert.equal(py.status, 0, py.stderr);
    assert.match(py.stdout, /^3 None\n/);
    assert.match(py.stdout, /фото 1\.jpg \d+/);
    if (HAS_UNZIP) {
      const un = spawnSync('unzip', ['-tq', file], { encoding: 'utf8' });
      assert.equal(un.status, 0, un.stdout + un.stderr);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('больше 65535 записей: используется zip64 и архив остаётся читаемым', async () => {
  const entries: ZipEntry[] = [];
  for (let i = 0; i < 65600; i++) entries.push(mem(`f${i}.jpg`, Buffer.alloc(0)));
  const { file, dir, bytes } = await build(entries);
  try {
    assert.equal(bytes, zipSize(entries));
    const py = spawnSync('python3', ['-I', '-c', PY, file], { encoding: 'utf8' });
    assert.equal(py.status, 0, py.stderr);
    assert.match(py.stdout, /^65600 None\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('файл, изменившийся при упаковке, обрывает архив ошибкой', async () => {
  const e = mem('a.jpg', Buffer.from('12345'));
  e.size = 9;
  await assert.rejects(async () => {
    for await (const _ of zipStream([e])) void _;
  }, /изменился/);
});
