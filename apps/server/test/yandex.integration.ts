// «Яндекс Диск» на настоящем Postgres и диске: поддельный Диск (список, ссылки, файлы) и поддельный помощник входа по QR.
// Проверяется весь путь: подключение, шифрование сессии, список, забор, повторы, сверка, общее хранение, отключение.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from 'pg';
import { startEnv } from './helpers/filesenv';

process.env.DVCLOUD_YANDEX_TICK_MS = '200';
process.env.DVCLOUD_YANDEX_RETRY_MIN = '0.01';
process.env.DVCLOUD_NO_THUMB_MIGRATION = '1';
process.env.DVCLOUD_YANDEX_SYNC_CHECK_MS = '200'; // ночная сверка: проверка раз в 0,2 с, окно «ночи» на все сутки
process.env.DVCLOUD_YANDEX_SYNC_FROM = '0';
process.env.DVCLOUD_YANDEX_SYNC_TO = '24';

const COOKIES = [
  { name: 'Session_id', value: 'sess-secret-value', domain: '.yandex.ru' },
  { name: 'yandexuid', value: '1234567890', domain: '.yandex.ru' },
  { name: 'sessionid2', value: 'sess2-secret-value', domain: '.yandex.ru' },
  { name: 'tracker', value: 'x', domain: '.example.com' },
];

const jpeg = (seed: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(seed.repeat(200))]);
const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex');

interface Item { name: string; data: Buffer; listMd5?: string; mtime?: number; mode?: 'ok' | 'down-once' | 'gone' | 'corrupt' }

describe('Яндекс Диск (настоящий Postgres, поддельные Яндекс и помощник входа)', () => {
  const e = startEnv();
  const { api, intCall } = e;
  let disk: Server, helper: Server, diskBase = '', helperBase = '';
  let sessionOk = true;
  let loginPolls = 0;
  const downloads = new Map<string, number>();
  const downOnce = new Set<string>();
  const items: Item[] = [
    { name: '1970-06-08 12-50-41.JPG', data: jpeg('a'), mtime: 1690000000 },
    { name: 'IMG_0002.jpg', data: jpeg('b'), mtime: 1700000000 },
    { name: 'IMG_0003.jpg', data: jpeg('c'), mtime: 1710000000, mode: 'down-once' },
    { name: 'IMG_0004.jpg', data: jpeg('d'), mtime: 1720000000, mode: 'corrupt', listMd5: 'f'.repeat(32) },
    { name: 'IMG_0005.jpg', data: jpeg('e'), mtime: 1725000000, mode: 'gone' },
    { name: 'notes.txt', data: Buffer.from('текст'), mtime: 1726000000 },
    { name: 'VID_0006.mp4', data: Buffer.concat([Buffer.from('....ftypisom'), Buffer.from('v'.repeat(500))]) },
  ];
  const pathOf = (i: Item) => `/photounlim/${i.name}`;
  const wait = async (check: () => Promise<boolean>, ms = 30_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  };
  const dbq = async <T>(sql: string): Promise<T[]> => {
    const c = new Client({ connectionString: e.dbUrl });
    await c.connect();
    try {
      return (await c.query(sql)).rows as T[];
    } finally {
      await c.end();
    }
  };
  const jr = (method: string, path: string, cookie: string, body?: unknown) => api(method, path, { cookie, body: body === undefined ? undefined : JSON.stringify(body), type: body === undefined ? undefined : 'application/json' });
  const status = async (cookie: string) => (await api('GET', '/api/yandex', { cookie })).json;
  const readBody = (req: IncomingMessage) => new Promise<string>((res) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => res(s)); });
  const hasSession = (req: IncomingMessage) => sessionOk && (req.headers.cookie ?? '').includes('Session_id=sess-secret-value');

  async function fakeDisk(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/client/disk') {
      if (!hasSession(req)) { res.writeHead(302, { location: 'https://passport.yandex.ru/auth' }).end(); return; }
      res.writeHead(200, { 'content-type': 'text/html' }).end('<script>var x={"sk":"SK123","uid":"4242"}</script>');
      return;
    }
    if (url.pathname === '/models-v2') {
      if (!hasSession(req)) { res.writeHead(403).end(); return; }
      const body = JSON.parse(await readBody(req));
      if (body.sk !== 'SK123') { res.writeHead(403).end(); return; }
      if (body.apiMethod === 'mpfs/list') {
        const { offset, amount } = body.requestParams;
        const page = items.slice(offset, offset + amount).map((i) => ({ path: pathOf(i), name: i.name, type: 'file', mtime: i.mtime, meta: { size: i.data.length, md5: i.listMd5 ?? md5(i.data) } }));
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(offset === 0 ? [{ path: '/photounlim', type: 'dir', name: 'photounlim' }, ...page] : page));
        return;
      }
      if (body.apiMethod === 'mpfs/url') {
        const it = items.find((i) => pathOf(i) === body.requestParams.path);
        if (!it || it.mode === 'gone') { res.writeHead(404).end(); return; }
        if (it.mode === 'down-once' && !downOnce.has(it.name)) { downOnce.add(it.name); res.writeHead(503).end(); return; }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ file: `${diskBase}/dl/${encodeURIComponent(it.name)}` }));
        return;
      }
    }
    if (url.pathname.startsWith('/dl/')) {
      if (!hasSession(req)) { res.writeHead(403).end(); return; }
      const name = decodeURIComponent(url.pathname.slice(4));
      const it = items.find((i) => i.name === name);
      downloads.set(name, (downloads.get(name) ?? 0) + 1);
      if (!it) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(it.data.length) }).end(it.data);
      return;
    }
    res.writeHead(404).end();
  }

  // Помощник входа: QR появляется со второго запроса, вход «подтверждается» после трёх опросов статуса.
  const qrCalls = new Map<string, number>();
  const finished: string[] = [];
  async function fakeHelper(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${e.helperToken}`) { res.writeHead(401).end(); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    const m = /^\/login\/([0-9a-f]+)(\/qr)?$/.exec(url.pathname);
    if (req.method === 'POST' && url.pathname === '/login') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'ab'.repeat(16) })); return; }
    if (m && m[2] && req.method === 'GET') {
      const n = (qrCalls.get(m[1]) ?? 0) + 1;
      qrCalls.set(m[1], n);
      if (n < 2) { res.writeHead(204).end(); return; }
      res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from('89504e470d0a1a0a', 'hex'));
      return;
    }
    if (m && !m[2] && req.method === 'GET') {
      loginPolls++;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(loginPolls < 3 ? { state: 'waiting' } : { state: 'done', cookies: COOKIES }));
      return;
    }
    if (m && req.method === 'DELETE') { finished.push(m[1]); res.writeHead(200).end('{}'); return; }
    res.writeHead(404).end();
  }

  const listen = (s: Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
  const connectFlow = async (cookie: string) => {
    loginPolls = 0;
    const c = await jr('POST', '/api/yandex/connect', cookie, {});
    assert.equal(c.status, 200, JSON.stringify(c.json));
    const id = c.json.id;
    let got = 0;
    assert.ok(await wait(async () => { const q = await api('GET', `/api/yandex/connect/${id}/qr`, { cookie }); got = q.status; return q.status === 200; }));
    assert.equal(got, 200);
    assert.ok(await wait(async () => (await api('GET', `/api/yandex/connect/${id}`, { cookie })).json.state === 'done'));
    return id;
  };

  before(async () => {
    disk = createServer((q, r) => void fakeDisk(q, r));
    helper = createServer((q, r) => void fakeHelper(q, r));
    diskBase = await listen(disk);
    helperBase = await listen(helper);
    await e.start({ DVCLOUD_SECRETS_KEY: 's'.repeat(40), DVCLOUD_YANDEX_LOGIN_URL: helperBase, DVCLOUD_YANDEX_LOGIN_TOKEN: e.helperToken, DVCLOUD_YANDEX_BASE: diskBase });
  });
  after(async () => {
    await e.stop();
    disk.close();
    helper.close();
  });

  it('до подключения: раздел включён, аккаунт не подключён; без входа в облако нельзя', async () => {
    const s = await status(e.anna);
    assert.deepEqual(s, { enabled: true, connected: false });
    assert.equal((await api('GET', '/api/yandex')).status, 401);
  });

  it('вход по QR: картинка, ожидание, подтверждение; сессия в базе только зашифрованной; чужой вход недоступен', async () => {
    const c = await jr('POST', '/api/yandex/connect', e.anna, {});
    const id = c.json.id;
    assert.equal((await api('GET', `/api/yandex/connect/${id}/qr`, { cookie: e.boris })).status, 404, 'чужой вход не виден');
    assert.equal((await api('GET', `/api/yandex/connect/${id}`, { cookie: e.boris })).status, 404);
    const first = await api('GET', `/api/yandex/connect/${id}/qr`, { cookie: e.anna });
    assert.equal(first.status, 204, 'QR ещё не готов');
    assert.ok(await wait(async () => (await api('GET', `/api/yandex/connect/${id}/qr`, { cookie: e.anna })).headers.get('content-type') === 'image/png'));
    assert.ok(await wait(async () => (await api('GET', `/api/yandex/connect/${id}`, { cookie: e.anna })).json.state === 'done'));
    assert.ok(finished.includes(id), 'помощнику сказано стереть вход');
    const s = await status(e.anna);
    assert.equal(s.connected, true);
    assert.equal(s.state, 'connected');
    const rows = await dbq<{ session: Buffer }>('SELECT session FROM yandex_accounts');
    assert.equal(rows.length, 1);
    const raw = rows[0].session.toString('latin1') + rows[0].session.toString('utf8');
    assert.ok(!raw.includes('sess-secret-value') && !raw.includes('Session_id'), 'куки в базе не открытым текстом');
    assert.equal((await status(e.boris)).connected, false, 'у другого человека не подключено');
  });

  it('чтение списка: файлы, годы, неизвестные даты', async () => {
    assert.equal((await jr('POST', '/api/yandex/list', e.anna, {})).status, 200);
    assert.ok(await wait(async () => (await status(e.anna)).list.state === 'idle' && (await status(e.anna)).counts.new === items.length));
    const s = await status(e.anna);
    assert.equal(s.counts.new, 7);
    assert.ok(s.list.at && /7/.test(s.list.note));
    assert.deepEqual(s.years.map((y: any) => y.year), [2024, 2023, null, 2024].sort((a, b) => (b ?? -1) - (a ?? -1)).filter((v, i, a) => a.indexOf(v) === i));
    const nul = s.years.find((y: any) => y.year === null);
    assert.equal(nul.n, 1, 'файл без даты один (видео)');
    const list = await api('GET', '/api/yandex/items?state=new&limit=3', { cookie: e.anna });
    assert.equal(list.json.total, 7);
    assert.equal(list.json.items.length, 3);
  });

  it('забор: файлы в библиотеке и в альбоме «Яндекс Диск», дата не 1970, повторы, сверка, пропуски', async () => {
    const r = await jr('POST', '/api/yandex/import', e.anna, {});
    assert.equal(r.json.queued, 7);
    assert.ok(await wait(async () => { const c = (await status(e.anna)).counts; return c.new + c.queued === 0 && c.done === 4; }), JSON.stringify((await status(e.anna)).counts) + JSON.stringify(await dbq("SELECT name, state, attempts, error FROM yandex_items WHERE state IN ('waiting', 'queued')")) + JSON.stringify(await dbq('SELECT import_state, import_note FROM yandex_accounts')));
    const s = await status(e.anna);
    assert.equal(s.counts.done, 4, 'забраны 3 фото и видео (+ повтор «упало один раз» после паузы)');
    assert.equal(s.counts.skipped, 1, 'notes.txt пропущен: не фото и не видео');
    assert.equal(s.counts.failed, 1, 'файла уже нет в Яндексе');
    assert.equal(s.counts.waiting, 1, 'файл с неверной контрольной суммой ждёт повтора');
    assert.ok((await dbq<{ error: string }>("SELECT error FROM yandex_items WHERE name = 'IMG_0004.jpg'"))[0].error.includes('Контрольная сумма'));
    const feed = (await api('GET', '/api/files?limit=50', { cookie: e.anna })).json.files;
    const names = feed.map((f: any) => f.name).sort();
    assert.deepEqual(names, ['1970-06-08 12-50-41.jpg', 'IMG_0002.jpg', 'IMG_0003.jpg', 'VID_0006.mp4']);
    const old = feed.find((f: any) => f.name.startsWith('1970'));
    assert.equal(new Date(old.takenAt).getUTCFullYear(), 2023, 'дата берётся из данных Яндекса, а не из имени (1970)');
    const albums = (await api('GET', '/api/albums', { cookie: e.anna })).json.albums;
    const al = albums.find((a: any) => a.name === 'Яндекс Диск');
    assert.ok(al && al.count === 4, JSON.stringify(albums));
    assert.equal((await dbq<{ n: string }>('SELECT count(*) AS n FROM blobs'))[0].n, '4');
  });

  it('второй человек с теми же файлами: ссылки без скачивания, на диске по-прежнему одна копия', async () => {
    await connectFlow(e.boris);
    await jr('POST', '/api/yandex/list', e.boris, {});
    assert.ok(await wait(async () => (await status(e.boris)).counts?.new === 7));
    const before = new Map(downloads);
    await jr('POST', '/api/yandex/import', e.boris, {});
    assert.ok(await wait(async () => (await status(e.boris)).counts.done === 4));
    for (const n of ['1970-06-08 12-50-41.JPG', 'IMG_0002.jpg', 'VID_0006.mp4']) assert.equal(downloads.get(n), before.get(n), `${n}: второй раз не скачивался`);
    assert.equal((await dbq<{ n: string }>('SELECT count(*) AS n FROM blobs'))[0].n, '4', 'на диске те же 4 содержимого');
    assert.equal((await dbq<{ n: string }>(`SELECT count(*) AS n FROM files f JOIN users u ON u.id = f.owner_id WHERE u.login = 'boris'`))[0].n, '4', 'у Бориса свои 4 ссылки');
    const note = (await dbq<{ error: string }>("SELECT error FROM yandex_items i JOIN yandex_accounts a ON a.id = i.account_id JOIN users u ON u.id = a.owner_id WHERE u.login = 'boris' AND i.name = 'IMG_0002.jpg'"))[0].error;
    assert.ok(note.includes('взята ссылка'));
  });

  it('вход устарел: помечается, список и забор не стартуют, после нового входа всё на месте', async () => {
    sessionOk = false;
    assert.equal((await jr('POST', '/api/yandex/list', e.anna, {})).status, 200);
    assert.ok(await wait(async () => (await status(e.anna)).state === 'expired'));
    const s = await status(e.anna);
    assert.ok(/подтвердите/.test(s.import.note), JSON.stringify(s.import));
    assert.equal((await jr('POST', '/api/yandex/list', e.anna, {})).status, 409);
    assert.equal((await jr('POST', '/api/yandex/import', e.anna, {})).status, 409);
    sessionOk = true;
    await connectFlow(e.anna);
    const s2 = await status(e.anna);
    assert.equal(s2.state, 'connected');
    assert.equal(s2.counts.done, 4, 'забранное осталось');
  });

  it('повторная сверка: новое находится и показывается, ночная сверка и автозабор, пауза не отменяется', async () => {
    const s0 = await status(e.anna);
    assert.equal(s0.sync.found, null, 'первое чтение списка не считается сверкой');
    assert.deepEqual([s0.sync.auto, s0.sync.autoImport], [false, false]);
    assert.equal((await jr('POST', '/api/yandex/settings', e.anna, { autoSync: 'да' })).status, 400);
    assert.equal((await api('POST', '/api/yandex/settings', { cookie: e.anna, body: '{}', type: 'text/plain' })).status, 415);

    // 1. Ручная сверка: на Диске появился файл, «Обновить список» находит ровно его
    items.push({ name: 'IMG_0100.jpg', data: jpeg('n'), mtime: 1730000000 });
    assert.equal((await jr('POST', '/api/yandex/list', e.anna, {})).status, 200);
    assert.ok(await wait(async () => (await status(e.anna)).sync.found === 1));
    const s1 = await status(e.anna);
    assert.equal(s1.sync.found, 1);
    assert.equal(s1.sync.foundBytes, items[items.length - 1].data.length);
    assert.ok(s1.sync.at);
    assert.equal(s1.sync.pending, s1.counts.new + s1.counts.queued);
    assert.equal(s1.counts.new, 1, 'забранное повторно не стало новым');

    // 2. Ночная сверка сама, без нажатия: список устарел, автосверка включена, автозабор включён
    assert.equal((await jr('POST', '/api/yandex/settings', e.anna, { autoSync: true, autoImport: true })).status, 200);
    items.push({ name: 'IMG_0101.jpg', data: jpeg('o'), mtime: 1731000000 });
    await dbq("UPDATE yandex_accounts SET listed_at = now() - interval '2 days' WHERE owner_id = (SELECT id FROM users WHERE login = 'anna')");
    assert.ok(await wait(async () => { const c = (await status(e.anna)).counts; return (await status(e.anna)).sync.found === 1 && c.done === 5; }), JSON.stringify(await status(e.anna)) + JSON.stringify(await dbq('SELECT auto_sync, auto_import, import_state, list_state, listed_at, sync_at FROM yandex_accounts')));
    const s2 = await status(e.anna);
    assert.equal(s2.counts.new, 1, 'IMG_0100 найден раньше, автозабор берёт только найденное в этой сверке');
    assert.ok((await api('GET', '/api/files?limit=50', { cookie: e.anna })).json.files.some((f: any) => f.name === 'IMG_0101.jpg'));

    // 3. Автозабор не отменяет вашу паузу
    await dbq("UPDATE yandex_accounts SET import_state = 'paused', import_note = 'Остановлено вами' WHERE owner_id = (SELECT id FROM users WHERE login = 'anna')"); // как после кнопки «Приостановить»
    items.push({ name: 'IMG_0102.jpg', data: jpeg('p'), mtime: 1732000000 });
    await dbq("UPDATE yandex_accounts SET listed_at = now() - interval '2 days' WHERE owner_id = (SELECT id FROM users WHERE login = 'anna')");
    assert.ok(await wait(async () => (await status(e.anna)).counts.new === 2));
    const s3 = await status(e.anna);
    assert.equal(s3.import.state, 'paused');
    assert.equal(s3.counts.done, 5);

    // 3б. Частота: раз в неделю и раз в месяц. Список двухдневной давности не перечитывается, недельной и месячной давности перечитывается
    assert.equal((await jr('POST', '/api/yandex/settings', e.anna, { syncDays: 3 })).status, 400);
    assert.equal((await jr('POST', '/api/yandex/settings', e.anna, { autoSync: true, syncDays: 7 })).status, 200);
    assert.equal((await status(e.anna)).sync.days, 7);
    items.push({ name: 'IMG_0104.jpg', data: jpeg('r'), mtime: 1733500000 });
    await dbq("UPDATE yandex_accounts SET listed_at = now() - interval '2 days' WHERE owner_id = (SELECT id FROM users WHERE login = 'anna')");
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await status(e.anna)).counts.new, 2, 'раз в неделю: двухдневный список ещё не пора перечитывать');
    await dbq("UPDATE yandex_accounts SET listed_at = now() - interval '8 days' WHERE owner_id = (SELECT id FROM users WHERE login = 'anna')");
    assert.ok(await wait(async () => (await status(e.anna)).counts.new === 3), 'раз в неделю: недельный список перечитан');
    assert.equal((await jr('POST', '/api/yandex/settings', e.anna, { syncDays: 30 })).status, 200);
    items.push({ name: 'IMG_0105.jpg', data: jpeg('s'), mtime: 1733600000 });
    await dbq("UPDATE yandex_accounts SET listed_at = now() - interval '10 days' WHERE owner_id = (SELECT id FROM users WHERE login = 'anna')");
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await status(e.anna)).counts.new, 3, 'раз в месяц: десять дней мало');
    await dbq("UPDATE yandex_accounts SET listed_at = now() - interval '33 days' WHERE owner_id = (SELECT id FROM users WHERE login = 'anna')");
    assert.ok(await wait(async () => (await status(e.anna)).counts.new === 4), 'раз в месяц: тридцатитрёхдневный список перечитан');
    await jr('POST', '/api/yandex/settings', e.anna, { syncDays: 1 });

    // 4. Выключили автосверку: список не читается, хотя устарел
    await jr('POST', '/api/yandex/settings', e.anna, { autoSync: false });
    const newBefore = (await status(e.anna)).counts.new;
    items.push({ name: 'IMG_0103.jpg', data: jpeg('q'), mtime: 1733000000 });
    await dbq("UPDATE yandex_accounts SET listed_at = now() - interval '2 days' WHERE owner_id = (SELECT id FROM users WHERE login = 'anna')");
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await status(e.anna)).counts.new, newBefore, 'без автосверки новое не читается');
  });

  it('квота: не хватает места, пауза с понятным текстом', async () => {
    await jr('POST', '/api/yandex/pause', e.boris, {});
    await dbq("UPDATE yandex_items SET state = 'new', error = NULL WHERE name = 'IMG_0004.jpg' AND account_id = (SELECT a.id FROM yandex_accounts a JOIN users u ON u.id = a.owner_id WHERE u.login = 'boris')");
    await dbq("UPDATE users SET quota_bytes = (SELECT COALESCE(sum(size_bytes), 0) FROM files WHERE owner_id = users.id) + 10 WHERE login = 'boris'");
    await jr('POST', '/api/yandex/import', e.boris, {});
    assert.ok(await wait(async () => (await status(e.boris)).import.state === 'paused'));
    const sb = await status(e.boris);
    assert.ok(/квот/.test(sb.import.note), JSON.stringify(sb.import) + JSON.stringify(sb.counts));
  });

  it('отключение: сессия и список стёрты, забранные файлы остались, повторное отключение безвредно', async () => {
    const filesBefore = (await api('GET', '/api/files?limit=50', { cookie: e.anna })).json.files.length;
    assert.equal((await api('DELETE', '/api/yandex', { cookie: e.anna })).status, 200);
    assert.deepEqual(await status(e.anna), { enabled: true, connected: false });
    assert.equal((await dbq<{ n: string }>('SELECT count(*) AS n FROM yandex_items i JOIN yandex_accounts a ON a.id = i.account_id JOIN users u ON u.id = a.owner_id WHERE u.login = \'anna\''))[0].n, '0');
    assert.equal((await api('GET', '/api/files?limit=50', { cookie: e.anna })).json.files.length, filesBefore);
    assert.equal((await api('DELETE', '/api/yandex', { cookie: e.anna })).status, 200);
    assert.equal((await jr('POST', '/api/yandex/list', e.anna, {})).status, 404);
  });

  it('проверка входных данных забора', async () => {
    assert.equal((await jr('POST', '/api/yandex/import', e.boris, { years: ['x'] })).status, 400);
    assert.equal((await jr('POST', '/api/yandex/import', e.boris, { years: [1800] })).status, 400);
    assert.equal((await api('POST', '/api/yandex/import', { cookie: e.boris, body: '{}', type: 'text/plain' })).status, 415);
  });
});
