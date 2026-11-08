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

test('сверка по хешу: файл, который уже есть в облаке, не отправляется, а своё и квота учитываются', async () => {
  let sent = 0;
  const send: Sender<ReturnType<typeof file>> = async (f) => {
    sent++;
    return { status: 201, json: { file: item(f.name) } };
  };
  const claim = async (f: ReturnType<typeof file>) => {
    if (f.name === 'have.jpg') return { sha256: 'x', state: 'linked' as const, file: item(f.name) };
    if (f.name === 'mine.jpg') return { sha256: 'x', state: 'mine' as const, file: item(f.name) };
    if (f.name === 'full.jpg') return { sha256: 'x', state: 'quota' as const };
    if (f.name === 'broken.jpg') throw new Error('сеть');
    return { sha256: 'x', state: 'unknown' as const };
  };
  let last: UploadJob[] = [];
  const got: string[] = [];
  const q = new UploadQueue(send, (j) => (last = j), (fi, dup) => got.push(`${fi.name}:${dup}`), 3, claim);
  q.add([file('have.jpg'), file('mine.jpg'), file('full.jpg'), file('new.jpg'), file('broken.jpg')]);
  await new Promise((r) => setTimeout(r, 60));
  const by = Object.fromEntries(last.map((j) => [j.name, j.status]));
  assert.deepEqual(by, { 'have.jpg': 'linked', 'mine.jpg': 'duplicate', 'full.jpg': 'error', 'new.jpg': 'done', 'broken.jpg': 'done' });
  assert.equal(sent, 2, 'по сети ушли только новый файл и тот, у которого сверка не удалась');
  assert.deepEqual(got.sort(), ['broken.jpg:false', 'have.jpg:false', 'mine.jpg:true', 'new.jpg:false']);
});

test('отмена ожидающих и повтор неудавшихся', async () => {
  let fail = true;
  const send: Sender<ReturnType<typeof file>> = async (f) => {
    await new Promise((r) => setTimeout(r, 5));
    if (f.name === 'a.jpg' && fail) return { status: 500, json: null };
    return { status: 201, json: { file: item(f.name) } };
  };
  let last: UploadJob[] = [];
  const q = new UploadQueue(send, (j) => (last = j), () => {}, 1);
  q.add([file('a.jpg'), file('b.jpg'), file('c.jpg'), file('d.jpg')]);
  q.cancelWaiting(); // a уже запущен, остальные ждали
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(last.map((j) => j.status), ['error', 'error', 'error', 'error']);
  assert.equal(last[1].error, 'Отменено');
  fail = false;
  q.retryFailed(); // «Отменено» не повторяется, a повторяется
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(last.map((j) => j.status), ['done', 'error', 'error', 'error']);
});
