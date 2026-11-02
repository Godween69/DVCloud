import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSupported, isVideo } from '../src/lib/media.ts';
import { UploadQueue, type Sender, type UploadJob } from '../src/lib/uploader.ts';

const file = (name: string, size = 10) => ({ name, size, lastModified: 0 });
const item = (name: string) => ({ id: name, name, mime: 'image/jpeg', size: 1, sha256: name, takenAt: '2026-05-01T00:00:00Z', createdAt: '2026-05-01T00:00:00Z', trashedAt: null });

test('форматы: фото и видео да, остальное нет', () => {
  for (const n of ['a.jpg', 'A.JPEG', 'x.heic', 'v.MP4', 'z.mov']) assert.ok(isSupported(n), n);
  for (const n of ['a.exe', 'a.svg', 'noext', '.jpg', 'a.jpg.php']) assert.ok(!isSupported(n), n);
  assert.ok(isVideo('video/mp4'));
  assert.ok(!isVideo('image/jpeg'));
});

test('очередь: одновременно не больше двух, все доходят до конца, статусы верные', async () => {
  let running = 0;
  let maxRunning = 0;
  const send: Sender<ReturnType<typeof file>> = async (f, onProgress) => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    onProgress(0.5);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    if (f.name === 'dup.jpg') return { status: 200, json: { duplicate: true, file: item(f.name) } };
    if (f.name === 'big.jpg') return { status: 413, json: { message: 'Файл больше допустимого размера или квоты' } };
    return { status: 201, json: { duplicate: false, file: item(f.name) } };
  };
  let last: UploadJob[] = [];
  const uploaded: string[] = [];
  const q = new UploadQueue(send, (j) => (last = j), (fi, dup) => uploaded.push(`${fi.name}:${dup}`), 2);
  q.add([file('a.jpg'), file('b.jpg'), file('dup.jpg'), file('big.jpg'), file('c.png'), file('virus.exe'), file('empty.jpg', 0)]);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(maxRunning, 2);
  const by = Object.fromEntries(last.map((j) => [j.name, j]));
  assert.equal(by['a.jpg'].status, 'done');
  assert.equal(by['dup.jpg'].status, 'duplicate');
  assert.equal(by['big.jpg'].status, 'error');
  assert.equal(by['big.jpg'].error, 'Файл больше допустимого размера или квоты');
  assert.equal(by['virus.exe'].error, 'Это не фото и не видео');
  assert.equal(by['empty.jpg'].error, 'Файл пустой');
  assert.deepEqual(uploaded.sort(), ['a.jpg:false', 'b.jpg:false', 'c.png:false', 'dup.jpg:true']);
  q.clearFinished();
  assert.equal(last.length, 0);
});

test('сбой сети попадает в статус ошибки, очередь идёт дальше', async () => {
  const send: Sender<ReturnType<typeof file>> = async (f) => {
    if (f.name === 'a.jpg') throw new Error('Сервер недоступен');
    return { status: 201, json: { file: item(f.name) } };
  };
  let last: UploadJob[] = [];
  const q = new UploadQueue(send, (j) => (last = j), () => {}, 1);
  q.add([file('a.jpg'), file('b.jpg')]);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(last.map((j) => j.status), ['error', 'done']);
});
