import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanFileName, contentDisposition, libraryDir, parseTakenAt, withSuffix } from '../src/files/names';

test('имя очищается: пути, управляющие символы, регистр расширения', () => {
  assert.equal(cleanFileName('IMG_0001.JPG')?.name, 'IMG_0001.jpg');
  assert.equal(cleanFileName('../../etc/passwd.jpg')?.name, 'passwd.jpg');
  assert.equal(cleanFileName('C:\\Users\\x\\отпуск 2026.MP4')?.name, 'отпуск 2026.mp4');
  assert.equal(cleanFileName('a\u0000b\nc.png')?.name, 'abc.png');
  assert.equal(cleanFileName('a:b*c?.png')?.name, 'a_b_c_.png');
  assert.equal(cleanFileName('...hidden.jpg')?.name, 'hidden.jpg');
});

test('не фото и не видео отвергаются', () => {
  for (const n of ['virus.exe', 'page.html', 'pic.svg', 'noext', '.jpg', 'a.jpg.php', '..', '']) {
    assert.equal(cleanFileName(n), null, n);
  }
});

test('слишком длинное имя укорачивается по байтам, расширение сохраняется', () => {
  const c = cleanFileName('я'.repeat(300) + '.jpg')!;
  assert.ok(Buffer.byteLength(c.name) <= 255);
  assert.ok(c.name.endsWith('.jpg'));
});

test('суффикс при совпадении имён', () => {
  const c = cleanFileName('IMG.jpg')!;
  assert.equal(withSuffix(c, 1), 'IMG.jpg');
  assert.equal(withSuffix(c, 2), 'IMG (2).jpg');
});

test('дата снимка: ISO, миллисекунды, секунды; странное заменяется на сейчас', () => {
  const now = Date.UTC(2026, 10, 2);
  assert.equal(parseTakenAt('2026-05-10T12:00:00Z', now).toISOString(), '2026-05-10T12:00:00.000Z');
  assert.equal(parseTakenAt(String(Date.UTC(2020, 0, 1)), now).toISOString(), '2020-01-01T00:00:00.000Z');
  assert.equal(parseTakenAt(String(Date.UTC(2020, 0, 1) / 1000), now).toISOString(), '2020-01-01T00:00:00.000Z');
  assert.equal(parseTakenAt('1970-01-01T00:00:00Z', now).getTime(), now);
  assert.equal(parseTakenAt('2099-01-01T00:00:00Z', now).getTime(), now);
  assert.equal(parseTakenAt('мусор', now).getTime(), now);
  assert.equal(parseTakenAt(undefined, now).getTime(), now);
});

test('папка библиотеки по UTC', () => {
  assert.equal(libraryDir('anna', new Date('2026-05-10T12:00:00Z')), 'library/anna/2026/05');
  assert.equal(libraryDir('anna', new Date('2026-12-31T23:59:59Z')), 'library/anna/2026/12');
});

test('Content-Disposition: имя в UTF-8, без кавычек и переводов строк', () => {
  const h = contentDisposition('отпуск "1".jpg', false);
  assert.ok(h.startsWith('inline; filename="'));
  assert.ok(!/[\r\n]/.test(h));
  assert.ok(h.includes("filename*=UTF-8''%D0%BE"));
  assert.ok(contentDisposition('a.jpg', true).startsWith('attachment;'));
});
