import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';
import { open, seal } from '../src/yandex/crypto';
import { parseListPage, parseMtime, YandexAuthError, YandexDisk, YandexGone, YandexRateLimit } from '../src/yandex/disk.client';

const KEY = 'k'.repeat(40);

describe('шифрование сессии', () => {
  it('туда и обратно, шифртекст не содержит открытых значений', () => {
    const blob = seal(KEY, { Session_id: 'секретное-значение-123' });
    assert.ok(!blob.toString('latin1').includes('секретное') && !blob.toString('utf8').includes('Session_id'));
    assert.deepEqual(open(KEY, blob), { Session_id: 'секретное-значение-123' });
  });
  it('чужой ключ и подмена дают ошибку', () => {
    const blob = seal(KEY, { a: 1 });
    assert.throws(() => open('z'.repeat(40), blob));
    const bad = Buffer.from(blob);
    bad[bad.length - 1] ^= 1;
    assert.throws(() => open(KEY, bad));
    assert.throws(() => open(KEY, Buffer.from([2, 0, 0])));
  });
  it('каждый раз новый шифртекст', () => {
    assert.notDeepEqual(seal(KEY, { a: 1 }), seal(KEY, { a: 1 }));
  });
});

describe('разбор списка безлимита', () => {
  it('берёт файлы под /photounlim, пропускает папки и чужие пути, читает md5 и время', () => {
    const r = parseListPage([
      { path: '/photounlim', type: 'dir', name: 'photounlim' },
      { path: '/photounlim/a.jpg', name: 'a.jpg', mtime: 1700000000, meta: { size: 10, md5: 'A'.repeat(32) } },
      { path: '/photounlim/sub', type: 'dir' },
      { path: '/disk/b.jpg', name: 'b.jpg' },
      { path: '/photounlim/c.mp4', meta: { size: '5', md5: 'не-md5' }, mtime: 1000 },
    ]);
    assert.equal(r.length, 2);
    assert.equal(r[0].md5, 'a'.repeat(32));
    assert.equal(r[0].size, 10);
    assert.equal(r[0].mtime?.getUTCFullYear(), 2023);
    assert.equal(r[1].name, 'c.mp4');
    assert.equal(r[1].md5, null);
    assert.equal(r[1].mtime, null, 'неправдоподобное время (1970) не берётся');
  });
  it('не массив: ошибка', () => assert.throws(() => parseListPage({ error: 1 })));
  it('время: секунды, миллисекунды, ISO, мусор', () => {
    assert.equal(parseMtime(1700000000)?.toISOString(), '2023-11-14T22:13:20.000Z');
    assert.equal(parseMtime(1700000000000)?.toISOString(), '2023-11-14T22:13:20.000Z');
    assert.equal(parseMtime('2023-11-14T22:13:20Z')?.toISOString(), '2023-11-14T22:13:20.000Z');
    assert.equal(parseMtime('мусор'), null);
    assert.equal(parseMtime(0), null);
    assert.equal(parseMtime(null), null);
  });
});

describe('клиент Диска: куки и ошибки', () => {
  const html = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers });

  it('куки уходят только на адреса Яндекса, не на чужой сервер после редиректа', async () => {
    const seen: { url: string; cookie: string | null }[] = [];
    const fake: typeof fetch = async (url, init) => {
      const u = String(url);
      seen.push({ url: u, cookie: new Headers(init?.headers).get('cookie') });
      if (u.startsWith('https://downloader.disk.yandex.ru/')) return html('', 302, { location: 'https://evil.example/steal' });
      return html('data', 200, { 'content-type': 'image/jpeg', 'content-length': '4' });
    };
    const d = new YandexDisk('https://disk.yandex.ru', { Session_id: 'S' }, fake);
    const dl = await d.download('https://downloader.disk.yandex.ru/x');
    for await (const _ of dl.stream) void _;
    assert.equal(seen[0].cookie, 'Session_id=S');
    assert.equal(seen[1].url, 'https://evil.example/steal');
    assert.equal(seen[1].cookie, null);
    assert.equal(dl.md5(), '8d777f385d3dfec8815d20f7496026dc');
  });

  it('вход не принят: перенаправление на passport = ошибка входа', async () => {
    const d = new YandexDisk('https://disk.yandex.ru', {}, async () => html('', 302, { location: 'https://passport.yandex.ru/auth?x=1' }));
    await assert.rejects(() => d.open(), YandexAuthError);
  });

  it('капча и 429 = просьба помолчать; 404 на ссылку = файла нет', async () => {
    const mk = (resp: () => Response) => new YandexDisk('https://disk.yandex.ru', {}, async (url) => (String(url).includes('/client/disk') ? html('{"sk":"s","uid":"1"}') : resp()));
    await assert.rejects(() => mk(() => html('<form action="/captcha">', 200)).api('mpfs/url', {}), YandexRateLimit);
    await assert.rejects(() => mk(() => html('', 429)).api('mpfs/url', {}), YandexRateLimit);
    await assert.rejects(() => mk(() => html('', 404)).fileUrl('/photounlim/x.jpg'), YandexGone);
    await assert.rejects(() => mk(() => html(JSON.stringify({ error: { title: 'Resource not found' } }))).fileUrl('/photounlim/x.jpg'), YandexGone);
  });

  it('вместо файла пришла страница: отказ', async () => {
    const d = new YandexDisk('https://disk.yandex.ru', {}, async () => html('<html>', 200, { 'content-type': 'text/html' }));
    await assert.rejects(() => d.download('https://downloader.disk.yandex.ru/x'));
  });
});

describe('настройки раздела «Яндекс Диск»', () => {
  const base = { DVCLOUD_DATABASE_URL: 'postgres://x', DVCLOUD_INTERNAL_TOKEN: 't'.repeat(40) };
  it('по умолчанию выключен', () => {
    const c = loadConfig(base);
    assert.equal(c.yandexLoginUrl, '');
    assert.equal(c.yandexBase, 'https://disk.yandex.ru');
  });
  it('нужны адрес помощника, ключ и общий секрет вместе', () => {
    assert.throws(() => loadConfig({ ...base, DVCLOUD_YANDEX_LOGIN_URL: 'http://login:8099' }), /DVCLOUD_SECRETS_KEY/);
    assert.throws(() => loadConfig({ ...base, DVCLOUD_YANDEX_LOGIN_URL: 'http://login:8099', DVCLOUD_SECRETS_KEY: KEY }), /DVCLOUD_YANDEX_LOGIN_TOKEN/);
    assert.throws(() => loadConfig({ ...base, DVCLOUD_SECRETS_KEY: 'коротко' }), /не короче 32/);
    assert.throws(() => loadConfig({ ...base, DVCLOUD_YANDEX_LOGIN_URL: 'ftp://x', DVCLOUD_SECRETS_KEY: KEY, DVCLOUD_YANDEX_LOGIN_TOKEN: 'y'.repeat(40) }), /http/);
    const ok = loadConfig({ ...base, DVCLOUD_YANDEX_LOGIN_URL: 'http://login:8099/', DVCLOUD_SECRETS_KEY: KEY, DVCLOUD_YANDEX_LOGIN_TOKEN: 'y'.repeat(40) });
    assert.equal(ok.yandexLoginUrl, 'http://login:8099');
  });
});
