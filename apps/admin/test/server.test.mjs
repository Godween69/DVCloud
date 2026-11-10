// Проверка админки целиком с поддельным внутренним сервером (без базы и без сети).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createAdminApp } from '../server.mjs';
import { createApi } from '../lib/api.mjs';
import { hashPassword } from '../lib/password.mjs';

const TOKEN = 't'.repeat(40);
const PASSWORD = 'correct horse battery';

describe('админка', () => {
  let fake, admin, base, port;
  const users = [{ id: '1', login: 'anna', displayName: '<img src=x onerror=alert(1)>', isAdmin: false, disabled: false, quotaBytes: null, createdAt: '2026-11-02T00:00:00.000Z' }];
  const calls = [];
  let backupCfg = { kind: 'folder', folder: '', host: '', port: 22, user: '', path: '', withDerived: false, limitMbit: 0 };
  let backupJob = null;
  const backupState = () => ({ config: backupCfg, rootAvailable: true, publicKey: backupCfg.kind === 'ssh' ? 'ssh-ed25519 AAAATESTKEY dvcloud-backup' : null, job: backupJob, last: { state: 'done', step: 'Готово', percent: 100, startedAt: '2026-11-08T08:00:00.000Z', finishedAt: '2026-11-08T08:30:00.000Z', error: null, result: { files: 120, bytes: 5368709120, dumpBytes: 20480, pending: 0, destination: '/backup/dvcloud-backup' } } });
  let peopleJob = null; // что сервер отдаёт как состояние долгой операции над группами

  before(async () => {
    fake = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const j = (status, obj) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        if (req.headers.authorization !== `Bearer ${TOKEN}`) return j(401, { message: 'Нужен токен' });
        calls.push(`${req.method} ${req.url} ${body}`);
        if (req.method === 'GET' && req.url === '/internal/users') return j(200, { users });
        if (req.method === 'POST' && req.url === '/internal/users') {
          const b = JSON.parse(body);
          if (users.some((u) => u.login === b.login)) return j(409, { message: 'Такой логин уже есть' });
          const user = { ...users[0], id: '2', login: b.login, displayName: b.displayName };
          users.push(user);
          return j(201, { user, password: 'abcd2345efgh6789' });
        }
        const m = /^\/internal\/users\/([a-z0-9_]+)(\/reset-password)?$/.exec(req.url);
        if (m && req.method === 'PATCH') return j(200, { user: { ...users[0], ...JSON.parse(body) } });
        if (/^\/internal\/users\/[a-z0-9_]+\/reset-2fa$/.test(req.url)) return j(200, { ok: true });
        if (m && m[2]) return j(200, { password: 'newpass23456789zz' });
        if (req.method === 'GET' && req.url === '/internal/stats') return j(200, { files: 5, blobs: 4, orphans: 1, orphanBytes: 2048, bytes: 1048576, extraCopies: 2 });
        if (req.method === 'GET' && req.url.startsWith('/internal/files/orphans')) return j(200, { orphans: [{ id: '7', name: '<b>x</b>.jpg', size: 2048, createdAt: '2026-11-01T10:00:00.000Z', note: 'Очистил корзину: anna. Был в альбомах: Отпуск', orphanedAt: '2026-11-02T09:00:00.000Z' }] });
        if (req.method === 'GET' && req.url.startsWith('/internal/duplicates?')) return j(200, { computedAt: '2026-11-09T09:00:00.000Z', scanning: false, totalGroups: 1, mergeable: 1, bulk: { running: false, total: 2, done: 2, failed: 1, bytes: 14110, finishedAt: '2026-11-09T16:50:00.000Z', problems: [{ group: '7', text: 'все рамки красные: ничего не оставлено, группа пропущена' }] }, reclaimBytes: 14110, groups: [{ id: '1', reclaimBytes: 14110, blobs: [{ blobId: '1', fileId: '11', width: 800, height: 600, size: 31192, keep: true, owners: [{ login: 'anna', files: 1 }] }, { blobId: '2', fileId: '12', width: 400, height: 300, size: 14110, keep: false, owners: [{ login: 'boris', files: 2 }] }] }] });
        if (req.method === 'POST' && req.url === '/internal/duplicates/scan') return j(200, { queued: true });
        if (req.method === 'POST' && req.url === '/internal/duplicates/merge') return j(200, { merged: 1, removedFiles: 0, bytes: 14110 });
        if (req.method === 'POST' && req.url === '/internal/duplicates/apply') return j(200, { started: 1 });
        if (req.method === 'GET' && req.url.startsWith('/internal/faces?')) return j(200, { total: 2, enabled: { faces: true, pets: true }, groups: [{ id: '5', name: 'Валя <b>', kind: 'person', count: 120, owners: ['anna', 'boris'], hiddenBy: 1, cover: '90' }, { id: '6', name: null, kind: 'pet', count: 4, owners: ['anna'], hiddenBy: 0, cover: '91' }] });
        if (req.method === 'GET' && req.url.startsWith('/internal/faces/5?')) return j(200, { group: { id: '5', name: 'Валя <b>', kind: 'person', count: 120, owners: ['anna', 'boris'], hiddenBy: 0, cover: '90' }, total: 2, faces: [{ id: '90', fileId: '41', owner: 'anna', source: 'manual', score: 0.9 }, { id: '92', fileId: '42', owner: 'boris', source: 'auto', score: 0.8 }] });
        if (req.method === 'GET' && req.url === '/internal/albums/3/dates') return j(200, { album: { id: '3', name: 'Отпуск', owner: 'anna' }, tz: 'Europe/Moscow', total: 2, files: [{ id: '41', name: 'a<b>.jpg', owner: 'anna', local: '2015-06-28T10:00:00', manual: false }, { id: '42', name: 'b.jpg', owner: 'anna', local: '2015-06-28T10:05:30', manual: true }] });
        if (req.method === 'POST' && req.url === '/internal/albums/3/dates') return j(200, { changed: JSON.parse(body).mode === 'each' ? JSON.parse(body).items.length : 2, firstBefore: null, firstAfter: null, lastAfter: null });
        if (req.method === 'POST' && req.url === '/internal/albums/3/remove-files') return j(200, { removed: JSON.parse(body).ids.length });
        if (req.method === 'GET' && req.url.startsWith('/internal/faces/6?')) return j(200, { group: { id: '6', name: null, kind: 'pet', count: 4, owners: ['anna'], hiddenBy: 0, cover: '91' }, total: 1, faces: [] });
        if (req.method === 'GET' && req.url === '/internal/faces/detections/90/crop') { res.writeHead(200, { 'content-type': 'image/webp', 'content-length': 4 }); return res.end('WEBP'); }
        if (req.method === 'PATCH' && req.url === '/internal/faces/5') return j(200, { ok: true });
        if (req.method === 'POST' && req.url === '/internal/faces/merge') return j(200, { merged: JSON.parse(body).from.length });
        if (req.method === 'DELETE' && req.url === '/internal/faces/6') return j(200, { ok: true });
        if (req.method === 'POST' && req.url === '/internal/faces/5/remove-face') return j(200, { ok: true });
        if (req.method === 'GET' && req.url === '/internal/albums-deleted') return j(200, { albums: [{ id: '8', name: 'Личное <i>', owner: 'boris', count: 4, sharedWith: 0, deletedAt: '2026-11-08T10:00:00.000Z' }] });
        if (req.method === 'POST' && req.url === '/internal/albums/8/restore') return j(200, { name: 'Личное (2)' });
        if (req.method === 'DELETE' && req.url === '/internal/albums-deleted/8') return j(200, { ok: true });
        if (req.method === 'GET' && req.url === '/internal/albums') return j(200, { albums: [{ id: '3', name: 'Отпуск', owner: 'anna', count: 12, sharedWith: 1 }] });
        if (req.method === 'GET' && req.url === '/internal/albums/3/transfer-preview') return j(200, { files: 12, inOtherAlbums: 5, owner: 'anna' });
        if (req.method === 'GET' && req.url.startsWith('/internal/browse/files/41/info')) return j(200, { file: { id: '41', name: '<b>IMG_1</b>.jpg', mime: 'image/jpeg', size: 2048, owner: 'anna', takenAt: '2026-03-05T10:00:00.000Z', width: 800, height: 600, sha256: 'a'.repeat(64), createdAt: '2026-03-06T10:00:00.000Z', blobId: '9' }, albums: [{ id: '3', name: 'Отпуск', owner: 'anna' }], copies: ['boris'], prev: '40', next: null, evidence: { exif: { 'Модель': 'Cam <X>', DateTimeOriginal: '2015:06:01 10:00:00' }, exifDate: '2015-06-01T10:00:00.000Z', videoCreation: null, nameDate: null, used: 'meta' } });
        if (req.method === 'PATCH' && req.url === '/internal/browse/files/41/taken') return j(200, { takenAt: '2019-06-20T08:30:00.000Z' });
        if (req.method === 'GET' && req.url === '/internal/browse/files/41/original?dl=1') { res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': 4, 'content-disposition': "attachment; filename*=UTF-8''IMG_1.jpg" }); return res.end('JPEG'); }
        if (req.method === 'GET' && req.url.startsWith('/internal/browse/files?')) return j(200, { files: [{ id: '41', name: '<b>IMG_1</b>.jpg', mime: 'image/jpeg', size: 2048, owner: 'anna', takenAt: '2026-03-05T10:00:00.000Z' }], next: '2026-03-05T10:00:00.000Z_41', total: 90 });
        if (req.method === 'GET' && req.url === '/internal/browse/files/41/thumb') { res.writeHead(200, { 'content-type': 'image/webp', 'content-length': 4 }); return res.end('WEBP'); }
        if (req.method === 'GET' && req.url === '/internal/browse/files/41/original') { res.writeHead(req.headers.range ? 206 : 200, { 'content-type': 'image/jpeg', 'content-length': 4, 'accept-ranges': 'bytes' }); return res.end('JPEG'); }
        if (req.method === 'GET' && /^\/internal\/browse\/files\/\d+\/(thumb|original)$/.test(req.url)) return j(404, { message: 'нет' });
        if (req.method === 'GET' && req.url === '/internal/vault') return j(200, { albums: [{ id: '5', name: 'Тайный <b>', note: 'на всякий', fromLogin: 'anna', count: 7, bytes: 2048, createdAt: '2026-11-09T10:00:00.000Z' }] });
        if (req.method === 'POST' && req.url === '/internal/albums/3/to-vault') return j(200, { vaultId: '5', files: 12 });
        if (req.method === 'POST' && req.url === '/internal/vault/5/return') return j(200, { albumId: '9', linked: 7 });
        if (req.method === 'DELETE' && req.url === '/internal/vault/5') return j(200, { files: 7, bytes: 2048, kept: 0 });
        if (req.method === 'GET' && req.url === '/internal/albums/3/shares') return j(200, { logins: ['boris'] });
        if (req.method === 'PUT' && /^\/internal\/albums\/3\/shares\/[a-z0-9_]+$/.test(req.url)) return j(200, { ok: true });
        if (req.method === 'DELETE' && /^\/internal\/albums\/3\/shares\/[a-z0-9_]+$/.test(req.url)) return j(200, { ok: true });
        if (req.method === 'DELETE' && req.url === '/internal/albums/3/shares') return j(200, { removed: 1 });
        if (req.method === 'POST' && req.url === '/internal/albums/3/share-all') return j(200, { added: 2 });
        if (req.method === 'POST' && req.url === '/internal/share-everything') return j(200, { albums: 1, links: 3 });
        if (req.method === 'GET' && req.url === '/internal/backup') return j(200, backupState());
        if (req.method === 'PATCH' && req.url === '/internal/backup/config') { const b = JSON.parse(body); if (b.host === 'плохо') return j(400, { message: 'Сервер: адрес или имя' }); backupCfg = { ...backupCfg, ...b }; return j(200, backupState()); }
        if (req.method === 'POST' && req.url === '/internal/backup/check') return j(200, { where: '/backup/dvcloud-backup', freeBytes: 5 * 1024 ** 3 });
        if (req.method === 'POST' && req.url === '/internal/backup/start') { backupJob = { state: 'running', step: 'Копирую файлы', percent: 42, startedAt: '2026-11-09T08:00:00.000Z', finishedAt: null, error: null, result: null }; return j(200, { job: backupJob }); }
        if (req.method === 'GET' && req.url === '/internal/quota-requests') return j(200, { requests: [{ id: '9', login: 'anna', displayName: 'Анна', needBytes: 5368709120, note: 'отпуск', createdAt: '2026-11-02T00:00:00.000Z', usedBytes: 1073741824, quotaBytes: 2147483648 }] });
        if (req.method === 'POST' && req.url === '/internal/files/dedupe') return j(200, { checked: 2, removed: JSON.parse(body).apply ? 2 : 0, freedBytes: 4096, mismatched: [] });
        if (req.method === 'POST' && req.url === '/internal/files/orphans/purge') return JSON.parse(body).confirm === 1 ? j(200, { count: 1, bytes: 2048, skipped: 0 }) : j(409, { message: 'Файлов без владельца сейчас 1' });
        if (req.method === 'POST' && /^\/internal\/files\/\d+\/purge$/.test(req.url)) return j(200, { links: 0, bytes: 2048 });
        if (req.method === 'POST' && /^\/internal\/files\/\d+\/adopt$/.test(req.url)) return j(200, { fileId: '55' });
        if (req.method === 'POST' && /^\/internal\/albums\/\d+\/transfer$/.test(req.url)) return j(200, { albumId: '4', linked: 12 });
        if (req.method === 'DELETE' && /^\/internal\/albums\/\d+$/.test(req.url)) return j(200, { ok: true });
        if (req.method === 'GET' && req.url === '/internal/media') return j(200, { settings: { previewEnabled: true, previewMaxSide: 2000, previewQuality: 80, videoEnabled: false, videoHeight: 720, videoCrf: 28, timezone: 'UTC', searchEnabled: false, searchCutoff: 80, facesEnabled: true, petsEnabled: false, facesSim: 45 }, thumbs: { files: 10, bytes: 1048576 }, previews: { files: 3, bytes: 2097152 }, videos: { copies: { files: 1, bytes: 5242880 }, total: 4, totalBytes: 1073741824, ready: 1, skipped: 1, failed: 0, pending: 2 }, search: { total: 100, ready: 40, failed: 2, pending: 58, configured: true, up: true, modelFiles: true, model: 'xlm-test', sizeBytes: 81920 }, people: { faces: { enabled: true, modelFiles: true, total: 100, done: 60, failed: 1, pending: 39 }, pets: { enabled: false, modelFiles: false, total: 100, done: 0, failed: 0, pending: 100 }, detections: { faces: 75, pets: 0 }, groups: 6, named: 2 }, peopleJob });
        if (req.method === 'PATCH' && req.url === '/internal/media/settings') { const b = JSON.parse(body); return b.previewMaxSide < 600 ? j(400, { message: 'previewMaxSide: целое число от 600 до 4000' }) : j(200, { settings: b, cleared: b.previewMaxSide ? ['previews'] : [] }); }
        if (req.method === 'GET' && req.url === '/internal/media/dates') return j(200, { job: { running: false, apply: false, startedAt: 'x', finishedAt: 'y', total: 100, checked: 100, changed: 3, examples: [{ name: '<i>a</i>.jpg', before: '2025-07-01T09:45:00.000Z', after: '2020-05-25T18:55:28.000Z' }] } });
        if (req.method === 'POST' && req.url === '/internal/media/dates') return j(200, { job: { running: true, apply: JSON.parse(body).apply, total: 100, checked: 0, changed: 0, examples: [] } });
        if (req.method === 'POST' && req.url === '/internal/media/clear') return j(200, { files: 7, bytes: 100 });
        if (req.method === 'POST' && req.url === '/internal/media/people/rebuild') { if (peopleJob?.state === 'running') return j(409, { message: 'Уже идёт пересборка групп: дождитесь конца' }); peopleJob = { kind: 'rebuild', state: 'running', step: 0, steps: 2, text: 'Подготовка', elapsedSec: 0 }; return j(200, { job: peopleJob }); }
        if (req.method === 'POST' && req.url === '/internal/media/people/hint') { peopleJob = { kind: 'hint', state: 'running', step: 0, steps: 6, text: 'Считаю', elapsedSec: 0 }; return j(200, { job: peopleJob }); }
        if (req.method === 'POST' && /^\/internal\/quota-requests\/\d+\/resolve$/.test(req.url)) return j(200, { ok: true });
        if (req.method === 'DELETE' && /^\/internal\/users\/[a-z0-9_]+/.test(req.url)) return j(200, { links: 3 });
        j(404, { message: 'нет' });
      });
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const api = createApi({ baseUrl: `http://127.0.0.1:${fake.address().port}`, token: TOKEN });
    admin = createAdminApp({ cfg: { passwordHash: hashPassword(PASSWORD), extraHosts: [], cookieSecure: false }, api });
    await new Promise((r) => admin.listen(0, '127.0.0.1', r));
    port = admin.address().port;
    base = `http://127.0.0.1:${port}`;
  });

  after(() => {
    admin.close();
    fake.close();
  });

  // Запрос через node:http, чтобы управлять заголовком Host.
  const req = (method, path, { form, cookie, host } = {}) =>
    new Promise((resolve, reject) => {
      const body = form ? new URLSearchParams(form).toString() : undefined;
      const r = request(
        { host: '127.0.0.1', port, method, path, headers: { host: host ?? `127.0.0.1:${port}`, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } : {}) } },
        (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
        },
      );
      r.on('error', reject);
      if (body) r.write(body);
      r.end();
    });

  async function login() {
    const r = await req('POST', '/login', { form: { password: PASSWORD } });
    assert.equal(r.status, 303);
    return r.headers['set-cookie'][0].split(';')[0];
  }
  const csrfOf = (page) => /name="csrf" value="([^"]+)"/.exec(page)[1];

  it('чужой Host отвергается (защита от DNS rebinding)', async () => {
    assert.equal((await req('GET', '/login', { host: 'evil.example' })).status, 400);
  });

  it('без входа всё ведёт на страницу входа, заголовки защиты на месте', async () => {
    const r = await req('GET', '/');
    assert.equal(r.status, 303);
    assert.equal(r.headers.location, '/login');
    const p = await req('GET', '/login');
    assert.match(p.headers['content-security-policy'], /default-src 'none'/);
    assert.equal(p.headers['x-frame-options'], 'DENY');
  });

  it('вход: кука HttpOnly+SameSite=Strict, список людей, имена экранированы', async () => {
    const r = await req('POST', '/login', { form: { password: PASSWORD } });
    assert.match(r.headers['set-cookie'][0], /HttpOnly/);
    assert.match(r.headers['set-cookie'][0], /SameSite=Strict/);
    const cookie = r.headers['set-cookie'][0].split(';')[0];
    const page = await req('GET', '/', { cookie });
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('anna'));
    assert.ok(!page.text.includes('<img src=x'), 'имя с разметкой не должно попасть в страницу как есть');
    assert.ok(page.text.includes('&lt;img src=x'));
  });

  it('создание человека показывает пароль один раз', async () => {
    const cookie = await login();
    const csrf = csrfOf((await req('GET', '/', { cookie })).text);
    const r = await req('POST', '/users', { cookie, form: { csrf, login: 'boris', displayName: 'Борис' } });
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('abcd2345efgh6789'));
    assert.equal(r.headers['cache-control'], 'no-store');
    const again = await req('GET', '/', { cookie });
    assert.ok(!again.text.includes('abcd2345efgh6789'));
  });

  it('галочка «Ребёнок» при создании, переключение роли, исправление даты снимка', async () => {
    const cookie = await login();
    const csrf = csrfOf((await req('GET', '/', { cookie })).text);
    assert.ok((await req('GET', '/', { cookie })).text.includes('name="isChild"'));
    await req('POST', '/users', { cookie, form: { csrf, login: 'kid', displayName: 'Малыш', isChild: '1' } });
    assert.ok(calls.some((c) => c.startsWith('POST /internal/users ') && c.includes('"isChild":true')));
    await req('POST', '/users/anna/child', { cookie, form: { csrf } });
    assert.ok(calls.some((c) => c.startsWith('PATCH /internal/users/anna') && c.includes('"isChild":true')));
    const page = await req('GET', '/files/41', { cookie });
    assert.ok(page.text.includes('взято из метаданных файла') && page.text.includes('2015:06:01 10:00:00') && page.text.includes('Cam &lt;X&gt;'));
    const r = await req('POST', '/files/41/taken', { cookie, form: { csrf, takenAt: '2019-06-20T08:30' } });
    assert.equal(r.status, 303);
    assert.ok(calls.some((c) => c.startsWith('PATCH /internal/browse/files/41/taken') && c.includes('2019-06-20T08:30:00Z')));
    await req('POST', '/files/41/taken', { cookie, form: { csrf, takenAt: 'вчера' } });
    assert.equal(calls.filter((c) => c.startsWith('PATCH /internal/browse/files/41/taken')).length, 1, 'неверная дата не уходит на сервер');
  });

  it('дубль логина: сообщение об ошибке, пароль не показан', async () => {
    const cookie = await login();
    const csrf = csrfOf((await req('GET', '/', { cookie })).text);
    const r = await req('POST', '/users', { cookie, form: { csrf, login: 'anna', displayName: 'X' } });
    assert.equal(r.status, 303);
    const page = await req('GET', '/', { cookie });
    assert.ok(page.text.includes('Такой логин уже есть'));
  });

  it('отключение, квота и сброс пароля доходят до сервера', async () => {
    const cookie = await login();
    const csrf = csrfOf((await req('GET', '/', { cookie })).text);
    await req('POST', '/users/anna/disable', { cookie, form: { csrf } });
    await req('POST', '/users/anna/quota', { cookie, form: { csrf, quota: '500' } });
    const reset = await req('POST', '/users/anna/reset', { cookie, form: { csrf } });
    assert.ok(reset.text.includes('newpass23456789zz'));
    assert.ok(calls.some((c) => c.startsWith('PATCH /internal/users/anna') && c.includes('"disabled":true')));
    assert.ok(calls.some((c) => c.includes(`"quotaBytes":${500 * 1024 ** 3}`)));
  });

  it('сброс второго фактора: кнопка только у тех, у кого он включён, запрос доходит до сервера', async () => {
    const cookie = await login();
    users[0].twoFactor = true;
    let page = await req('GET', '/', { cookie });
    assert.ok(page.text.includes('Сбросить 2FA'));
    assert.ok(page.text.includes('включена'));
    const csrf = csrfOf(page.text);
    const r = await req('POST', '/users/anna/reset2fa', { cookie, form: { csrf } });
    assert.equal(r.status, 303);
    assert.ok(calls.some((c) => c.startsWith('POST /internal/users/anna/reset-2fa')));
    assert.equal((await req('POST', '/users/anna/reset2fa', { cookie, form: { csrf: 'wrong' } })).status, 403);
    users[0].twoFactor = false;
    page = await req('GET', '/', { cookie });
    assert.ok(!page.text.includes('Сбросить 2FA'));
  });

  it('плохая квота не уходит на сервер', async () => {
    const cookie = await login();
    const csrf = csrfOf((await req('GET', '/', { cookie })).text);
    const before = calls.length;
    await req('POST', '/users/anna/quota', { cookie, form: { csrf, quota: 'много' } });
    assert.equal(calls.length, before);
  });

  it('запрос без токена защиты от подделки отклоняется', async () => {
    const cookie = await login();
    assert.equal((await req('POST', '/users/anna/disable', { cookie, form: { csrf: 'wrong' } })).status, 403);
    assert.equal((await req('POST', '/users/anna/disable', { cookie, form: {} })).status, 403);
  });

  it('страница «Хранилище»: сводка, просьбы, файлы без владельца, альбомы; имена экранированы', async () => {
    const cookie = await login();
    const page = await req('GET', '/storage', { cookie });
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('Отпуск'));
    assert.ok(page.text.includes('отпуск'));
    assert.ok(page.text.includes('5,0 ГБ'));
    assert.ok(!page.text.includes('<b>x</b>'), 'имя файла с разметкой не должно попасть как есть');
    assert.ok(page.text.includes('&lt;b&gt;x&lt;/b&gt;'));
    assert.ok(page.text.includes('Был в альбомах: Отпуск'), 'у бесхозного файла видно, откуда он');
    assert.ok(page.text.includes('Удалённые альбомы') && page.text.includes('Личное &lt;i&gt;'), 'удалённые альбомы показаны, имя экранировано');
    assert.ok(!page.text.includes('<i>'), 'разметка из имени альбома не попала как есть');
    assert.ok(page.text.includes('href="/duplicates"') && !page.text.includes('class="dupgroup"'), 'дубликаты переехали на свою вкладку');
    assert.equal((await req('GET', '/storage')).status, 303, 'без входа не открывается');
  });

  it('хранилище: стереть, отдать, скопировать альбом, задать квоту, закрыть просьбу', async () => {
    const cookie = await login();
    const csrf = csrfOf((await req('GET', '/storage', { cookie })).text);
    const post = (path, form) => req('POST', path, { cookie, form: { csrf, ...form } });
    assert.equal((await post('/storage/files/7/purge', {})).status, 303);
    assert.ok(calls.some((c) => c.startsWith('POST /internal/files/7/purge')));
    await post('/storage/files/7/adopt', { login: 'anna' });
    assert.ok(calls.some((c) => c.startsWith('POST /internal/files/7/adopt') && c.includes('"login":"anna"')));
    await post('/storage/albums/3/transfer', { login: 'boris' });
    assert.ok(calls.some((c) => c.startsWith('POST /internal/albums/3/transfer') && c.includes('"move":false')));
    await post('/storage/albums/3/delete', {});
    assert.ok(calls.some((c) => c.startsWith('DELETE /internal/albums/3')));
    await post('/storage/duplicates/merge', { keep: '1', drop: '2' });
    assert.ok(calls.some((c) => c.startsWith('POST /internal/duplicates/merge') && c.includes('"keep":"1"') && c.includes('"drop":["2"]')));
    const nDup = calls.length;
    await post('/storage/duplicates/merge', { keep: 'x', drop: '2' });
    assert.equal(calls.length, nDup, 'неверные номера на сервер не уходят');
    await post('/storage/duplicates/scan', {});
    assert.ok(calls.some((c) => c.startsWith('POST /internal/duplicates/scan')));
    // Вкладка «Дубликаты»: одна форма, рамки (скрытый флажок + полоса), приближение, страницы, «Применить» внизу после списка
    const page = (await req('GET', '/duplicates', { cookie })).text;
    assert.ok(calls.some((c) => c.startsWith('GET /internal/duplicates?offset=0&limit=50')), 'страница 1 по 50 групп');
    assert.ok(page.includes('class="dupbar"') && page.includes('action="/storage/duplicates/apply"'));
    assert.ok(page.includes('name="keep" value="1:1" checked') && page.includes('name="keep" value="1:2">'), 'лучший отмечен заранее, второй нет');
    assert.ok(page.includes('class="dupstrip" for="k-1-1"') && page.includes('800×600'), 'полоса-переключатель и размеры');
    assert.ok(page.includes('class="zoomhold"') && page.includes('/files/11/zoom') && page.includes('/files/11/thumb'), 'приближение зажатием');
    assert.ok(page.includes('<script src="/viewer.js"></script>'));
    assert.ok(page.includes('Последнее применение:') && page.includes('Группа 7: все рамки красные'), 'итог и причины пропусков видны сверху');
    assert.ok(page.indexOf('Последнее применение:') < page.indexOf('class="dupgroup"'));
    assert.ok(!page.includes('type="checkbox" id="k-1-1" name="keep" value="1:1" checked class'), 'флажок скрыт стилем, не атрибутом');
    const mf = page.slice(page.indexOf('action="/storage/duplicates/apply"'));
    assert.ok(!mf.slice(0, mf.indexOf('</form>')).includes('name="word"'), 'слово вводить не нужно');
    assert.ok(page.indexOf('class="dupgroup"') < page.indexOf('class="dupbar"'), 'кнопка внизу, после списка');
    assert.ok((await req('GET', '/duplicates?page=3&per=100', { cookie })).status === 200);
    assert.ok(calls.some((c) => c.startsWith('GET /internal/duplicates?offset=200&limit=100')), 'страница 3 по 100 даёт смещение 200');
    const nAll = calls.length;
    await req('POST', '/storage/duplicates/apply', { cookie, form: [['csrf', csrf]] });
    assert.equal(calls.length, nAll, 'без групп удаление не запускается');
    const back = await req('POST', '/storage/duplicates/apply', { cookie, form: [['csrf', csrf], ['page', '2'], ['per', '100'], ['g', '1'], ['keep', '1:1'], ['keep', '1:2'], ['keep', '9:5']] });
    assert.equal(back.headers.location, '/duplicates?page=2&per=100', 'после применения возвращаемся на ту же страницу');
    const sent = calls.filter((c) => c.startsWith('POST /internal/duplicates/apply')).pop();
    assert.ok(sent && sent.includes('"group":"1"') && sent.includes('"keep":["1","2"]') && !sent.includes('"5"'), sent);
    await post('/storage/albums-deleted/8/restore', {});
    assert.ok(calls.some((c) => c.startsWith('POST /internal/albums/8/restore')));
    await post('/storage/albums-deleted/8/purge', {});
    assert.ok(calls.some((c) => c.startsWith('DELETE /internal/albums-deleted/8')));
    const before = calls.length;
    await post('/storage/requests/9/grant', { login: 'anna', quota: 'много' });
    assert.equal(calls.length, before, 'плохая квота не уходит на сервер');
    await post('/storage/requests/9/grant', { login: 'anna', quota: '20' });
    assert.ok(calls.some((c) => c.startsWith('PATCH /internal/users/anna') && c.includes(`"quotaBytes":${20 * 1024 ** 3}`)));
    assert.ok(calls.some((c) => c.startsWith('POST /internal/quota-requests/9/resolve')));
    // массовая чистка: без слова и с чужим числом на сервер уходит только верное
    const n0 = calls.length;
    await post('/storage/orphans/purge', { count: '1', word: 'нет' });
    assert.equal(calls.length, n0, 'без слова «стереть» запроса нет');
    await post('/storage/orphans/purge', { count: '5', word: 'стереть' });
    assert.ok(calls.some((c) => c.startsWith('POST /internal/files/orphans/purge') && c.includes('"confirm":5')));
    await post('/storage/orphans/purge', { count: '1', word: ' Стереть ' });
    assert.ok(calls.some((c) => c.startsWith('POST /internal/files/orphans/purge') && c.includes('"confirm":1')));
    const page2 = await req('GET', '/storage', { cookie });
    assert.ok(page2.text.includes('впишите: стереть') && page2.text.includes('Стереть с диска все 1'));
    await post('/storage/dedupe', { apply: '1' });
    const after = await req('GET', '/storage', { cookie });
    assert.ok(after.text.includes('удалено: 2'));
    assert.equal((await req('POST', '/storage/files/7/purge', { cookie, form: { csrf: 'wrong' } })).status, 403);
  });

  it('страница «Люди»: аватар, полоса квоты и меню действий на раскрывающемся блоке, без скриптов', async () => {
    users[0].quotaBytes = 10 * 1024 ** 3;
    users[0].usedBytes = 4 * 1024 ** 3;
    try {
      const cookie = await login();
      const page = await req('GET', '/', { cookie });
      assert.ok(page.text.includes('class="menu"'), 'меню действий');
      assert.ok(page.text.includes('<meter'), 'полоса квоты');
      assert.ok(page.text.includes('4,0 ГБ из 10 ГБ'));
      assert.ok(page.text.includes('Добавить человека'));
      assert.ok(!page.text.includes('<script'));
      assert.ok(page.text.includes('href="/media"'), 'вкладка про превью и видео');
    } finally {
      users[0].quotaBytes = null;
      delete users[0].usedBytes;
    }
  });

  it('страница «Превью и видео»: счётчики, настройки, очистка, ошибка сервера показывается', async () => {
    const cookie = await login();
    const page = await req('GET', '/media', { cookie });
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('Копии видео'));
    assert.ok(page.text.includes('готово 1 из 4'));
    assert.ok(page.text.includes('name="previewMaxSide"'));
    assert.ok(page.text.includes('value="2000"'));
    assert.equal((await req('GET', '/media')).status, 303, 'без входа не открывается');
    const csrf = csrfOf(page.text);
    const post = (path, form) => req('POST', path, { cookie, form: { csrf, ...form } });
    const ok = await post('/media/settings', { previewEnabled: '1', previewMaxSide: '1600', previewQuality: '75', videoHeight: '480', videoCrf: '31' });
    assert.equal(ok.status, 303);
    const sent = calls.filter((c) => c.startsWith('PATCH /internal/media/settings')).pop();
    assert.ok(sent.includes('"previewMaxSide":1600') && sent.includes('"videoEnabled":false') && sent.includes('"previewEnabled":true') && sent.includes('"videoCrf":31'));
    assert.ok((await req('GET', '/media', { cookie })).text.includes('Стёрты и построятся заново: превью'));
    await post('/media/settings', { previewMaxSide: '100' });
    assert.ok((await req('GET', '/media', { cookie })).text.includes('целое число от 600 до 4000'));
    assert.ok(page.text.includes('name="timezone"') && page.text.includes('Даты у загруженных файлов'));
    assert.ok(page.text.includes('2020-05-25 18:55') && !page.text.includes('<i>a</i>'), 'пример: дата показана, имя экранировано');
    await post('/media/dates', { apply: '0' });
    assert.ok(calls.some((c) => c.startsWith('POST /internal/media/dates') && c.includes('"apply":false')));
    await post('/media/dates', { apply: '1' });
    assert.ok(calls.some((c) => c.startsWith('POST /internal/media/dates') && c.includes('"apply":true')));
    await post('/media/settings', { previewEnabled: '1', timezone: 'Europe/Moscow' });
    assert.ok(calls.filter((c) => c.startsWith('PATCH /internal/media/settings')).pop().includes('"timezone":"Europe/Moscow"'));
    await post('/media/clear', { what: 'videos' });
    assert.ok(calls.some((c) => c.startsWith('POST /internal/media/clear') && c.includes('"what":"videos"')));
    assert.equal((await req('POST', '/media/clear', { cookie, form: { csrf: 'wrong', what: 'videos' } })).status, 403);
  });

  it('поиск по смыслу: панель с ходом и состоянием службы, настройки и сброс векторов', async () => {
    const cookie = await login();
    const page = await req('GET', '/media', { cookie });
    assert.ok(page.text.includes('Поиск по смыслу'));
    assert.ok(page.text.includes('Готово 40 из 100, не удалось прочитать: 2, в очереди: 58'));
    assert.ok(page.text.includes('работает, модель xlm-test'));
    assert.ok(page.text.includes('name="searchEnabled"') && page.text.includes('name="searchCutoff"') && page.text.includes('value="80"'));
    assert.ok(page.text.includes('Повторить неудачные'), 'есть неудачные: кнопка повтора видна');
    const csrf = csrfOf(page.text);
    const post = (path, form) => req('POST', path, { cookie, form: { csrf, ...form } });
    await post('/media/settings', { searchEnabled: '1', searchCutoff: '70' });
    const sent = calls.filter((c) => c.startsWith('PATCH /internal/media/settings')).pop();
    assert.ok(sent.includes('"searchEnabled":true') && sent.includes('"searchCutoff":70'), sent);
    await post('/media/settings', { previewEnabled: '1' });
    assert.ok(calls.filter((c) => c.startsWith('PATCH /internal/media/settings')).pop().includes('"searchEnabled":false'), 'снятая галочка выключает поиск');
    await post('/media/clear', { what: 'index-failed' });
    assert.ok(calls.some((c) => c.startsWith('POST /internal/media/clear') && c.includes('"what":"index-failed"')));
    assert.ok((await req('GET', '/media', { cookie })).text.includes('Сброшено записей поиска'));
  });

  it('люди и питомцы: панель с ходом, настройки, стирание только со словом', async () => {
    const cookie = await login();
    const page = await req('GET', '/media', { cookie });
    assert.ok(page.text.includes('Люди и питомцы') && page.text.includes('Найдено лиц: 75, питомцев: 0. Групп: 6, из них названо людьми: 2.'));
    assert.ok(page.text.includes('Готово 60 из 100, не удалось прочитать: 1, в очереди: 39'));
    assert.ok(page.text.includes('<b>Лица:</b> идёт просмотр') && page.text.includes('<b>Питомцы:</b> выключено'));
    assert.ok(page.text.includes('name="facesEnabled" value="1" checked') && !page.text.includes('name="petsEnabled" value="1" checked'));
    const csrf = csrfOf(page.text);
    const post = (path, form) => req('POST', path, { cookie, form: { csrf, ...form } });
    await post('/media/settings', { facesEnabled: '1', petsEnabled: '1' });
    const sent = calls.filter((c) => c.startsWith('PATCH /internal/media/settings')).pop();
    assert.ok(sent.includes('"facesEnabled":true') && sent.includes('"petsEnabled":true'), sent);
    await post('/media/settings', { previewEnabled: '1' });
    assert.ok(calls.filter((c) => c.startsWith('PATCH /internal/media/settings')).pop().includes('"facesEnabled":false'), 'снятая галочка выключает лица');
    const before = calls.filter((c) => c.includes('"what":"people"')).length;
    await post('/media/clear', { what: 'people' });
    await post('/media/clear', { what: 'people', word: 'нет' });
    assert.equal(calls.filter((c) => c.includes('"what":"people"')).length, before, 'без слова ничего не стирается');
    assert.ok((await req('GET', '/media', { cookie })).text.includes('впишите слово'));
    await post('/media/clear', { what: 'people', word: ' Стереть ' });
    assert.equal(calls.filter((c) => c.includes('"what":"people"')).length, before + 1);
    assert.ok((await req('GET', '/media', { cookie })).text.includes('Стёрто находок: 7'));
  });

  it('строгость лиц, подсказка по числу групп и «Пересобрать группы»: запуск, ход, итог', async () => {
    const cookie = await login();
    const page = await req('GET', '/media', { cookie });
    assert.ok(page.text.includes('name="facesSim" min="30" max="55" step="1" value="45"'));
    assert.ok(page.text.includes('Остаются как есть:') && page.text.includes('группы с именем'), 'предупреждение про названные группы на месте');
    assert.ok(!page.text.includes('http-equiv="refresh"') && !page.text.includes(' disabled'), 'пока ничего не идёт: ни обновления, ни заблокированных кнопок');
    const csrf = csrfOf(page.text);
    const post = (path, form) => req('POST', path, { cookie, form: { csrf, ...form } });
    await post('/media/settings', { facesSim: '38' });
    assert.ok(calls.filter((c) => c.startsWith('PATCH /internal/media/settings')).pop().includes('"facesSim":38'));
    assert.equal((await req('POST', '/media/people/rebuild', { cookie, form: { csrf: 'wrong' } })).status, 403);
    // подсчёт запущен: видно ход, страница обновляется сама, кнопки заблокированы
    await post('/media/people/hint', {});
    let run = (await req('GET', '/media', { cookie })).text;
    assert.ok(run.includes('Подсчёт групп: идёт.') && run.includes('Считаю. Прошло 0 с.') && run.includes('<progress max="6" value="0"'), 'ход подсчёта виден');
    assert.ok(run.includes('http-equiv="refresh" content="3"') && (run.match(/ disabled/g) ?? []).length === 2, 'страница обновляется, обе кнопки заблокированы');
    assert.ok(run.includes('Пока ничего') || run.includes('Подсчёт запущен'), 'после нажатия сказано, что запущено');
    // подсчёт закончился: итог остаётся в панели
    peopleJob = { kind: 'hint', state: 'done', step: 6, steps: 6, text: 'Готово', elapsedSec: 9, hint: [{ sim: 30, groups: 20, ungrouped: 5 }, { sim: 45, groups: 322, ungrouped: 90 }] };
    run = (await req('GET', '/media', { cookie })).text;
    assert.ok(run.includes('Подсчёт готов') && run.includes('при 0,30: 20 групп, без группы останется 5 лиц') && run.includes('при 0,45: 322 групп'), 'итог подсчёта');
    assert.ok(!run.includes('http-equiv="refresh"') && !run.includes(' disabled'), 'после конца обновление и блокировка сняты');
    // пересборка: запуск, ход, итог; повторный запуск во время работы отклоняется
    peopleJob = null;
    await post('/media/people/rebuild', {});
    assert.ok(calls.some((c) => c.startsWith('POST /internal/media/people/rebuild')));
    run = (await req('GET', '/media', { cookie })).text;
    assert.ok(run.includes('Пересборка групп: идёт.'));
    await post('/media/people/rebuild', {});
    assert.ok((await req('GET', '/media', { cookie })).text.includes('Уже идёт пересборка групп'), 'вторая пересборка не стартует');
    peopleJob = { kind: 'rebuild', state: 'done', step: 2, steps: 2, text: 'Готово', elapsedSec: 31, rebuild: { removed: 41, created: 12, kept: 18 } };
    run = (await req('GET', '/media', { cookie })).text;
    assert.ok(run.includes('Пересборка групп готова') && run.includes('Безымянных групп стёрто: 41, собрано заново: 12') && run.includes('Всего групп людей теперь: 18'));
    peopleJob = { kind: 'rebuild', state: 'error', step: 1, steps: 2, text: 'Не получилось', elapsedSec: 3, error: 'сбой базы' };
    assert.ok((await req('GET', '/media', { cookie })).text.includes('Пересборка групп: не получилось.') );
    peopleJob = null;
  });

  it('страница «Файлы»: плитки с превью, фильтры уходят на сервер, имена экранируются, «Показать ещё» хранит фильтры', async () => {
    const cookie = await login();
    const page = await req('GET', '/files?login=anna&from=2026-03-01&q=IMG', { cookie });
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('data="/files/41/thumb"') && page.text.includes('href="/files/41?login=anna'), 'плитка ведёт на просмотр с тем же фильтром');
    assert.ok(!page.text.includes('<b>IMG_1</b>'), 'имя файла экранировано');
    assert.ok(page.text.includes('Найдено: <b>90</b>'));
    assert.ok(page.text.includes('before=2026-03-05'), 'ссылка на следующую страницу');
    assert.ok(page.text.includes('login=anna'), 'фильтр сохраняется в ссылке');
    assert.ok(!page.text.includes('<script'));
    assert.ok(calls.some((c) => c.startsWith('GET /internal/browse/files?') && c.includes('login=anna') && c.includes('from=2026-03-01') && c.includes('q=IMG') && c.includes('limit=60')));
    assert.ok(page.text.includes('class="info"'), 'кнопка «Инфо»');
  });

  it('просмотр файла: карточка, соседи, скачивание, скрипт; чужого нет', async () => {
    const cookie = await login();
    const page = await req('GET', '/files/41?login=anna&q=IMG', { cookie });
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('src="/files/41/view"') && page.text.includes('/files/41/download'));
    assert.ok(page.text.includes('rel="prev" href="/files/40?login=anna&amp;q=IMG"'), 'сосед сохраняет фильтр');
    assert.ok(page.text.includes('data-back href="/files?login=anna&amp;q=IMG"'));
    assert.ok(page.text.includes('boris') && page.text.includes('800×600') && page.text.includes('Отпуск'));
    assert.ok(!page.text.includes('<b>IMG_1</b>'), 'имя экранировано');
    assert.ok(page.text.includes('<script src="/viewer.js"></script>') && !/<script>/.test(page.text), 'только внешний скрипт');
    assert.ok(calls.some((c) => c.startsWith('GET /internal/browse/files/41/info?') && c.includes('login=anna') && c.includes('q=IMG')));
    const d = await fetch(`${base}/files/41/download`, { headers: { cookie: `dvcloud_admin=${cookie.split('=')[1] ?? ''}` } });
    assert.equal(d.status, 200);
    assert.match(d.headers.get('content-disposition') ?? '', /^attachment/);
    await d.text();
    const js = await fetch(`${base}/viewer.js`);
    assert.equal(js.status, 200);
    assert.ok((await js.text()).includes('contextmenu'));
    assert.equal((await req('GET', '/files/41', {})).status, 303, 'без входа нельзя');
    assert.equal((await req('GET', '/files/abc', { cookie })).status, 404);
  });

  it('миниатюра и файл отдаются через админку; без входа нельзя; чужих путей нет', async () => {
    const cookie = await login();
    const t = await fetch(`${base}/files/41/thumb`, { headers: { cookie: `dvcloud_admin=${cookie.split('=')[1] ?? ''}`, host: `127.0.0.1:${port}` } });
    assert.equal(t.status, 200);
    assert.equal(t.headers.get('content-type'), 'image/webp');
    assert.equal(await t.text(), 'WEBP');
    assert.ok(t.headers.get('content-security-policy').includes("img-src 'self'"));
    const o = await fetch(`${base}/files/41/view`, { headers: { cookie: `dvcloud_admin=${cookie.split('=')[1] ?? ''}`, range: 'bytes=0-3' } });
    assert.equal(o.status, 206, 'Range доходит до сервера');
    assert.equal((await fetch(`${base}/files/99/thumb`, { headers: { cookie: `dvcloud_admin=${cookie.split('=')[1] ?? ''}` } })).status, 404);
    assert.equal((await fetch(`${base}/files/41/thumb`, { redirect: 'manual' })).status, 303, 'без входа на страницу входа');
    assert.equal((await req('GET', '/files/41/..%2f..%2fusers', { cookie })).status, 404);
  });

  it('«Альбомы людям»: кому открыт, открыть одному, всем, закрыть; «всё всем» только со словом', async () => {
    const cookie = await login();
    const page = await req('GET', '/sharing', { cookie });
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('Отпуск') && page.text.includes('boris'));
    const csrf = csrfOf(page.text);
    const post = (path, form) => req('POST', path, { cookie, form: { csrf, ...form } });
    await post('/sharing/3/add', { login: 'boris' });
    assert.ok(calls.some((c) => c.startsWith('PUT /internal/albums/3/shares/boris')));
    await post('/sharing/3/remove', { login: 'boris' });
    assert.ok(calls.some((c) => c.startsWith('DELETE /internal/albums/3/shares/boris')));
    await post('/sharing/3/all', {});
    assert.ok(calls.some((c) => c.startsWith('POST /internal/albums/3/share-all')));
    assert.ok(page.text.includes('Скрыть у всех'), 'у альбома с доступами есть кнопка скрытия');
    await post('/sharing/3/hide', {});
    assert.ok(calls.some((c) => c.startsWith('DELETE /internal/albums/3/shares ')), 'скрыть у всех снимает все доступы');
    const n = calls.length;
    await post('/sharing/everything', { word: 'нет' });
    assert.equal(calls.length, n, 'без слова запроса нет');
    await post('/sharing/everything', { word: ' Раздать ' });
    assert.ok(calls.some((c) => c.startsWith('POST /internal/share-everything') && c.includes('"confirm":true')));
    assert.ok((await req('GET', '/sharing', { cookie })).text.includes('новых доступов открыто: 3'));
    assert.equal((await req('POST', '/sharing/3/all', { cookie, form: { csrf: 'wrong' } })).status, 403);
  });

  it('«Альбомы людям»: карточки с флажками, сохранение разницы, передача; в сейф только с паролем админки', async () => {
    const cookie = await login();
    const page = (await req('GET', '/sharing', { cookie })).text;
    assert.ok(page.includes('class="acard"') && page.includes('name="login" value="boris" checked'), 'у boris флажок стоит: альбом ему открыт');
    assert.ok(page.includes('Владелец: <b>anna</b>') && page.includes('Забрать у владельца в сейф'));
    assert.ok(!(await req('GET', '/sharing?owner=boris', { cookie })).text.includes('Отпуск'), 'фильтр по владельцу');
    const csrf = csrfOf(page);
    const post = (path, form) => req('POST', path, { cookie, form: form instanceof Array ? [['csrf', csrf], ...form] : { csrf, ...form } });
    // снят флажок у boris, отмечен carol: одно закрытие и одно открытие
    const n0 = calls.length;
    await post('/sharing/3/set', [['login', 'carol']]);
    const made = calls.slice(n0);
    assert.ok(made.some((c) => c.startsWith('PUT /internal/albums/3/shares/carol')) && made.some((c) => c.startsWith('DELETE /internal/albums/3/shares/boris')), made.join(' | '));
    const n2 = calls.length;
    const ask = await post('/sharing/3/transfer', { login: 'boris' });
    assert.equal(ask.headers.location, '/sharing/3/transfer?login=boris', 'без подтверждения ничего не передаётся');
    assert.equal(calls.length, n2);
    const conf = await req('GET', '/sharing/3/transfer?login=boris', { cookie });
    assert.equal(conf.status, 200);
    assert.ok(conf.text.includes('Файлы уйдут вместе с альбомом') && conf.text.includes('<b>5</b>') && conf.text.includes('<b>12</b>'), 'в подтверждении точные числа');
    await post('/sharing/3/transfer', { login: 'boris', confirm: '1' });
    assert.ok(calls.some((c) => c.startsWith('POST /internal/albums/3/transfer') && c.includes('"move":true')));
    // сейф: с неверным паролем запроса нет, с верным есть
    const n1 = calls.length;
    await post('/sharing/3/vault', { password: 'неверный', note: 'x' });
    assert.equal(calls.length, n1, 'без пароля админки в сейф не кладётся');
    const r = await post('/sharing/3/vault', { password: PASSWORD, note: 'x' });
    assert.equal(r.status, 303);
    assert.ok(calls.some((c) => c.startsWith('POST /internal/albums/3/to-vault') && c.includes('"note":"x"')));
  });

  it('«Сейф»: список, вернуть и стереть только после пароля админки', async () => {
    const cookie = await login();
    const page = (await req('GET', '/vault', { cookie })).text;
    assert.ok(page.includes('Тайный &lt;b&gt;') && page.includes('Забран у: <b>anna</b>'), 'название экранировано');
    const csrf = csrfOf(page);
    const post = (path, form) => req('POST', path, { cookie, form: { csrf, ...form } });
    const n = calls.length;
    await post('/vault/5/return', { login: 'boris', password: 'нет' });
    await post('/vault/5/erase', { password: 'нет' });
    assert.equal(calls.length, n, 'с неверным паролем ничего не уходит');
    await post('/vault/5/return', { login: 'boris', password: PASSWORD });
    assert.ok(calls.some((c) => c.startsWith('POST /internal/vault/5/return') && c.includes('"login":"boris"')));
    await post('/vault/5/erase', { password: PASSWORD });
    assert.ok(calls.some((c) => c.startsWith('DELETE /internal/vault/5')));
    assert.equal((await req('POST', '/vault/5/erase', { cookie, form: { csrf: 'wrong', password: PASSWORD } })).status, 403);
  });

  it('страница «Копия»: способы, ключ для SSH, запуск только кнопкой, ход, ошибки сервера', async () => {
    const cookie = await login();
    let page = await req('GET', '/backup', { cookie });
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('Диск или папка') && page.text.includes('Другой сервер по SSH') && page.text.includes('Сделать копию сейчас'));
    assert.ok(page.text.includes('Последняя удачная') && page.text.includes('расхождений нет'));
    assert.ok(!page.text.includes('<script') && !page.text.includes('http-equiv="refresh"'));
    const csrf = csrfOf(page.text);
    const post = (path, form) => req('POST', path, { cookie, form: { csrf, ...form } });
    await post('/backup/ssh', { host: 'backup.example.org', port: '2222', user: 'dv', path: '/srv/dv' });
    assert.ok(calls.some((c) => c.startsWith('PATCH /internal/backup/config') && c.includes('"kind":"ssh"') && c.includes('"port":2222') && c.includes('"host":"backup.example.org"')));
    page = await req('GET', '/backup', { cookie });
    assert.ok(page.text.includes('ssh-ed25519 AAAATESTKEY'), 'открытый ключ показан');
    assert.ok(!page.text.includes('PRIVATE'));
    await post('/backup/ssh', { host: 'плохо', port: '22', user: 'dv', path: '/srv/dv' });
    assert.ok((await req('GET', '/backup', { cookie })).text.includes('Сервер: адрес или имя'), 'ошибка сервера видна');
    await post('/backup/options', { withFiles: '1', readable: '1', folders: 'month', names: 'date', withAlbums: '1', withDerived: '1', limitMbit: '20' });
    const o = calls.filter((c) => c.startsWith('PATCH /internal/backup/config')).pop();
    for (const frag of ['"withFiles":true', '"withDb":false', '"mirror":false', '"readable":true', '"folders":"month"', '"names":"date"', '"withAlbums":true', '"withDerived":true', '"withTrash":false', '"limitMbit":20']) assert.ok(o.includes(frag), `${frag} в ${o}`);
    assert.ok((await req('GET', '/backup', { cookie })).text.includes('name="readable" value="1"'), 'флажки состава копии показаны');
    await post('/backup/folder', { folder: 'dvcloud' });
    assert.ok(calls.some((c) => c.startsWith('PATCH /internal/backup/config') && c.includes('"kind":"folder"') && c.includes('"folder":"dvcloud"')));
    await post('/backup/check', {});
    assert.ok((await req('GET', '/backup', { cookie })).text.includes('Место доступно'));
    const n = calls.length;
    await req('GET', '/backup', { cookie });
    assert.ok(!calls.slice(n).some((c) => c.includes('/backup/start')), 'открытие страницы копию не запускает');
    await post('/backup/start', {});
    assert.ok(calls.some((c) => c.startsWith('POST /internal/backup/start')));
    page = await req('GET', '/backup', { cookie });
    assert.ok(page.text.includes('<progress') && page.text.includes('42%') && page.text.includes('http-equiv="refresh"'), 'идёт: ход и автообновление');
    assert.ok(/<button class="primary" type="submit" disabled>/.test(page.text), 'кнопка запуска на время копии выключена');
    assert.equal((await req('POST', '/backup/start', { cookie, form: { csrf: 'wrong' } })).status, 403);
    backupJob = null;
  });

  it('удаление аккаунта требует ввести логин; «с файлами» передаётся как force', async () => {
    const cookie = await login();
    const csrf = csrfOf((await req('GET', '/', { cookie })).text);
    const before = calls.length;
    await req('POST', '/users/anna/delete', { cookie, form: { csrf, confirm: 'не тот' } });
    assert.equal(calls.length, before);
    await req('POST', '/users/anna/delete', { cookie, form: { csrf, confirm: 'anna', force: '1' } });
    assert.ok(calls.some((c) => c.startsWith('DELETE /internal/users/anna?force=1')));
    await req('POST', '/users/anna/delete', { cookie, form: { csrf, confirm: 'anna' } });
    assert.ok(calls.some((c) => c.startsWith('DELETE /internal/users/anna ')));
  });

  it('выход закрывает сессию', async () => {
    const cookie = await login();
    const csrf = csrfOf((await req('GET', '/', { cookie })).text);
    await req('POST', '/logout', { cookie, form: { csrf } });
    assert.equal((await req('GET', '/', { cookie })).status, 303);
  });

  it('вкладка «Лица»: список с крупными карточками, группа, вырезка, объединить, переименовать, убрать лицо, распустить', async () => {
    const cookie = await login();
    assert.equal((await req('GET', '/faces')).status, 303, 'без входа не открывается');
    const list = await req('GET', '/faces?kind=person&q=%D0%B2%D0%B0&unnamed=1', { cookie });
    assert.equal(list.status, 200);
    assert.ok(calls.some((c) => c.startsWith('GET /internal/faces?') && c.includes('kind=person') && c.includes('unnamed=1') && c.includes('limit=48')));
    assert.ok(list.text.includes('Валя &lt;b&gt;') && !list.text.includes('Валя <b>'), 'имя экранировано');
    assert.ok(list.text.includes('src="/faces/crop/90"') && list.text.includes('(общая)') && list.text.includes('скрыта у 1') && list.text.includes('питомец'));
    assert.ok(list.text.includes('href="/faces" aria-current="page"') || list.text.includes('aria-current="page">Лица'));
    const csrf = csrfOf(list.text);
    const post = (path, form) => req('POST', path, { cookie, form: { csrf, ...form } });
    const crop = await req('GET', '/faces/crop/90', { cookie });
    assert.equal(crop.status, 200);
    assert.equal(crop.headers['content-type'], 'image/webp');
    const one = await req('GET', '/faces/5', { cookie });
    assert.equal(one.status, 200);
    assert.ok(one.text.includes('Убрать из группы') && one.text.includes('/faces/crop/92') && one.text.includes('подписано человеком') && one.text.includes('Распустить группу'));
    // объединить
    assert.equal((await post('/faces/merge', { into: '5', from: '6' })).status, 303);
    assert.ok(calls.some((c) => c.startsWith('POST /internal/faces/merge') && c.includes('"into":"5"') && c.includes('"from":["6"]')));
    const n = calls.length;
    await post('/faces/merge', { into: 'x' });
    await post('/faces/merge', { into: '5' });
    assert.equal(calls.length, n, 'без группы или без «влить» на сервер ничего не уходит');
    await post('/faces/5/rename', { name: ' Валя ' });
    assert.ok(calls.some((c) => c.startsWith('PATCH /internal/faces/5') && c.includes('"name":"Валя"')));
    await post('/faces/5/rename', { clear: '1', name: 'x' });
    assert.ok(calls.some((c) => c.startsWith('PATCH /internal/faces/5') && c.includes('"name":null')));
    await post('/faces/5/rename', { name: '   ' });
    await post('/faces/5/remove-face', { det: '92', offset: '0' });
    assert.ok(calls.some((c) => c.startsWith('POST /internal/faces/5/remove-face') && c.includes('"detectionId":"92"')));
    const m = calls.length;
    await post('/faces/5/remove-face', { det: 'abc' });
    assert.equal(calls.length, m);
    await post('/faces/6/dissolve', {});
    assert.ok(calls.some((c) => c.startsWith('DELETE /internal/faces/6')));
    assert.equal((await post('/faces/zzz', {})).status, 404);
    // выбор групп хранится в сессии
    assert.ok(list.text.includes('class="selbox" value="5"') && list.text.includes('id="selbar" hidden'), 'выбора ещё нет, плашка скрыта');
    assert.ok(list.text.includes('Слить выбранные') && list.text.includes('/faces.js'));
    const js = await req('GET', '/faces.js', { cookie });
    assert.equal(js.status, 200);
    assert.ok(js.headers['content-type'].startsWith('text/javascript'));
    const one1 = await post('/faces/select', { id: '5', on: '1' });
    assert.equal(one1.status, 200);
    assert.equal(JSON.parse(one1.text).n, 1);
    assert.equal(JSON.parse((await post('/faces/select', { id: '6', on: '1' })).text).n, 2);
    assert.equal(JSON.parse((await post('/faces/select', { id: 'zz', on: '1' })).text).n, 2, 'мусор в выбор не попадает');
    const again = await req('GET', '/faces', { cookie });
    assert.ok(again.text.includes('class="selbox" value="5" checked') && !again.text.includes('id="selbar" hidden'), 'выбор виден после перезагрузки');
    // подгрузка страницы фрагментом: только карточки и заголовок X-More
    const frag = await req('GET', '/faces?page=2&frag=1', { cookie });
    assert.equal(frag.status, 200);
    assert.ok(frag.text.startsWith('<li class="face">') && !frag.text.includes('<html'));
    assert.equal(frag.headers['x-more'], '0');
    // страница слияния: главная одна, остальные вливаются; ссылки «Проверить» ведут с признаком слияния
    const mp = await req('GET', '/faces/merge', { cookie });
    assert.equal(mp.status, 200);
    assert.ok(mp.text.includes('name="into" class="mainpick" value="5" required') && mp.text.includes('name="from" value="6"') && mp.text.includes('href="/faces/5?merge=1"'));
    const onePg = await req('GET', '/faces/5?merge=1', { cookie });
    assert.ok(onePg.text.includes('Вернуться к слиянию') && onePg.text.includes('name="merge" value="1"'));
    // убрать из выбора, потом слить: выбор очищается
    assert.equal((await post('/faces/unselect', { id: '6' })).headers.location, '/faces/merge');
    assert.equal((await post('/faces/unselect', { id: '5' })).headers.location, '/faces');
    await post('/faces/select', { id: '5', on: '1' });
    const done = await post('/faces/merge', { into: '5', from: '6' });
    assert.equal(done.headers.location, '/faces');
    assert.equal(JSON.parse((await post('/faces/select', { id: '9', on: '0' })).text).n, 0, 'после слияния выбор пуст');
    assert.equal((await post('/faces/merge', { into: 'x' })).headers.location, '/faces/merge', 'при ошибке остаёмся на слиянии');
    assert.equal(JSON.parse((await post('/faces/select', { clear: '1' })).text).n, 0);
    assert.equal((await req('POST', '/faces/merge', { cookie, form: { into: '5', from: '6' } })).status, 403, 'без csrf нельзя');
  });

  it('вкладка «Даты»: выбор альбома, сдвиг, одна дата всем, правка по файлам, убрать из альбома', async () => {
    const cookie = await login();
    assert.equal((await req('GET', '/dates')).status, 303, 'без входа не открывается');
    const idle = await req('GET', '/dates', { cookie });
    assert.ok(idle.text.includes('anna: Отпуск (12)'));
    const csrf = csrfOf(idle.text);
    const post = (path, form) => req('POST', path, { cookie, form: { csrf, ...form } });
    const pg = await req('GET', '/dates?album=3', { cookie });
    assert.ok(pg.text.includes('a&lt;b&gt;.jpg') && !pg.text.includes('a<b>.jpg'), 'имя экранировано');
    assert.ok(pg.text.includes('name="t_41" value="2015-06-28T10:00:00"') && pg.text.includes('Europe/Moscow') && pg.text.includes('дата правлена'));
    assert.ok(pg.text.includes('src="/files/41/thumb"'));
    // сдвиг: datetime-local без секунд дополняется секундами
    assert.equal((await post('/dates/3/shift', { first: '2019-10-18T14:30' })).status, 303);
    assert.ok(calls.some((c) => c.startsWith('POST /internal/albums/3/dates') && c.includes('"mode":"shift"') && c.includes('"first":"2019-10-18T14:30:00"')));
    await post('/dates/3/all', { at: '2019-10-18T14:30:15' });
    assert.ok(calls.some((c) => c.includes('"mode":"all"') && c.includes('"at":"2019-10-18T14:30:15"')));
    // по файлам: уходят только изменённые
    await post('/dates/3/each', { t_41: '2015-06-28T10:00:00', o_41: '2015-06-28T10:00:00', t_42: '2019-10-18T15:00', o_42: '2015-06-28T10:05:30' });
    const each = calls.filter((c) => c.startsWith('POST /internal/albums/3/dates') && c.includes('"mode":"each"')).pop();
    assert.ok(each.includes('"id":"42"') && !each.includes('"id":"41"') && each.includes('2019-10-18T15:00:00'), each);
    const n = calls.length;
    await post('/dates/3/each', { t_41: '2015-06-28T10:00:00', o_41: '2015-06-28T10:00:00' });
    await post('/dates/3/remove', {});
    assert.equal(calls.length, n, 'без изменений и без отмеченных на сервер ничего не уходит');
    await post('/dates/3/remove', { rm: '41' });
    assert.ok(calls.some((c) => c.startsWith('POST /internal/albums/3/remove-files') && c.includes('"ids":["41"]')));
    assert.equal((await post('/dates/zz/shift', {})).status, 404);
    assert.equal((await req('POST', '/dates/3/shift', { cookie, form: { first: '2019-10-18T14:30' } })).status, 403, 'без csrf нельзя');
  });

  it('неверный пароль даёт 401, после 5 неудач вход блокируется даже с верным', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await req('POST', '/login', { form: { password: 'nope' } })).status, 401);
    assert.equal((await req('POST', '/login', { form: { password: PASSWORD } })).status, 429);
  });
});
