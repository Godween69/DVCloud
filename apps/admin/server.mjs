// Админка DV Cloud: люди, квоты, пароли. Слушает только локальный адрес, ходит на внутренний порт сервера.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { ApiError, createApi } from './lib/api.mjs';
import { loadAdminConfig } from './lib/config.mjs';
import { CSS, backupPage, filesPage, formatSize, loginPage, mediaPage, parseQuotaGb, secretPage, sharingPage, storagePage, usersPage } from './lib/html.mjs';
import { verifyPassword } from './lib/password.mjs';
import { createLimiter } from './lib/ratelimit.mjs';
import { createSessions } from './lib/sessions.mjs';

const COOKIE = 'dvcloud_admin';
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; style-src 'self'; img-src 'self'; media-src 'self'; object-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

function parseCookies(header) {
  const out = {};
  for (const raw of String(header ?? '').split(';')) {
    const part = raw.trim();
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

async function readForm(req) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) return null;
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 16 * 1024) return null;
    chunks.push(c);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export function createAdminApp({ cfg, api, now = Date.now }) {
  const sessions = createSessions({ now });
  const perIp = createLimiter({ max: 5, windowMs: 15 * 60 * 1000, now });
  const overall = createLimiter({ max: 20, windowMs: 15 * 60 * 1000, now });

  const send = (res, status, type, body, extra = {}) => {
    res.writeHead(status, { 'content-type': type, ...SECURITY_HEADERS, ...extra });
    res.end(body);
  };
  const html = (res, status, body) => send(res, status, 'text/html; charset=utf-8', body);
  const redirect = (res, to, extra = {}) => send(res, 303, 'text/plain; charset=utf-8', '', { location: to, ...extra });
  const cookie = (value, maxAge) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${cfg.cookieSecure ? '; Secure' : ''}`;

  // Настройки превью и видео. Числа из формы проверяет сервер DVCloud, его текст ошибки показывается как есть.
  async function mediaAction(session, res, path, form) {
    try {
      if (path === '/media/settings') {
        const num = (k) => (form.get(k) === null || form.get(k) === '' ? undefined : Number(form.get(k)));
        const patch = {
          previewEnabled: form.get('previewEnabled') === '1',
          previewMaxSide: num('previewMaxSide'),
          previewQuality: num('previewQuality'),
          videoEnabled: form.get('videoEnabled') === '1',
          videoHeight: num('videoHeight'),
          videoCrf: num('videoCrf'),
          timezone: (form.get('timezone') ?? '').trim() || undefined,
          searchEnabled: form.get('searchEnabled') === '1',
          searchCutoff: num('searchCutoff'),
          facesEnabled: form.get('facesEnabled') === '1',
          petsEnabled: form.get('petsEnabled') === '1',
          facesSim: num('facesSim'),
        };
        for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
        const r = await api.saveMedia(patch);
        const names = { previews: 'превью', videos: 'копии видео' };
        session.flash = { kind: 'ok', text: `Настройки сохранены${r.cleared.length ? `. Стёрты и построятся заново: ${r.cleared.map((c) => names[c] ?? c).join(', ')}` : ''}` };
      } else if (path === '/media/dates') {
        const apply = form.get('apply') === '1';
        const r = await api.startDates(apply);
        session.flash = { kind: 'ok', text: `${apply ? 'Пересчёт дат запущен' : 'Проверка дат запущена'}: файлов ${r.job.total}. Обновите страницу, чтобы увидеть ход.` };
      } else if (path === '/media/people/rebuild') {
        await api.rebuildPeople();
        session.flash = { kind: 'ok', text: 'Пересборка групп запущена. Ход виден в панели «Люди и питомцы», страница обновляется сама.' };
      } else if (path === '/media/people/hint') {
        await api.peopleHint();
        session.flash = { kind: 'ok', text: 'Подсчёт запущен. Результат появится в панели «Люди и питомцы», страница обновляется сама.' };
      } else if (path === '/media/clear') {
        const what = form.get('what') ?? '';
        // Данные лиц стираются целиком, вместе с названиями людей: нужно вписать слово.
        if (what === 'people' && (form.get('word') ?? '').trim().toLowerCase() !== 'стереть') throw new ApiError(400, 'Чтобы стереть данные лиц, впишите слово «стереть»');
        const r = await api.clearMedia(what);
        session.flash = { kind: 'ok', text: what === 'people' ? `Стёрто находок: ${r.files}. Групп и названий больше нет` : what.startsWith('index') ? `Сброшено записей поиска: ${r.files}. Они посчитаются заново в фоне` : `Очищено: ${r.files} файлов` };
      } else {
        return send(res, 404, 'text/plain; charset=utf-8', 'Нет такой страницы');
      }
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      session.flash = { kind: 'error', text: e.message };
    }
    return redirect(res, '/media');
  }

  async function storageAction(session, res, path, form) {
    const ok = (text) => { session.flash = { kind: 'ok', text }; };
    try {
      let m;
      if (path === '/storage/orphans/purge') {
        // Двойная защита: нужно вписать слово и число должно совпасть с тем, что сейчас на диске (проверяет сервер).
        const count = Number(form.get('count'));
        if ((form.get('word') ?? '').trim().toLowerCase() !== 'стереть') throw new ApiError(400, 'Чтобы стереть, впишите слово «стереть»');
        if (!Number.isInteger(count) || count < 0) throw new ApiError(400, 'Нет числа файлов: обновите страницу');
        const r = await api.purgeOrphans(count);
        ok(`Стёрто файлов без владельца: ${r.count}, освобождено ${formatSize(r.bytes)}${r.skipped ? `, пропущено (появился владелец): ${r.skipped}` : ''}`);
      } else if ((m = /^\/storage\/files\/(\d{1,18})\/(purge|adopt)$/.exec(path))) {
        if (m[2] === 'purge') {
          const r = await api.purge(m[1]);
          ok(`Стёрто с диска: ${r.bytes} байт`);
        } else {
          const login = form.get('login') ?? '';
          await api.adopt(m[1], login);
          ok(`Файл отдан: ${login}`);
        }
      } else if (path === '/storage/dedupe') {
        const apply = form.get('apply') === '1';
        session.dedupe = await api.dedupe(apply);
        ok(apply ? 'Лишние копии обработаны' : 'Проверка выполнена, ничего не удалено');
      } else if ((m = /^\/storage\/albums\/(\d{1,18})\/transfer$/.exec(path))) {
        const login = form.get('login') ?? '';
        const r = await api.transfer(m[1], login, false);
        ok(`Альбом скопирован человеку ${login}, файлов: ${r.linked}`);
      } else if ((m = /^\/storage\/albums\/(\d{1,18})\/delete$/.exec(path))) {
        await api.deleteAlbum(m[1]);
        ok('Альбом удалён, файлы остались');
      } else if ((m = /^\/storage\/requests\/(\d{1,18})\/(grant|resolve)$/.exec(path))) {
        if (m[2] === 'grant') {
          const q = parseQuotaGb(form.get('quota'));
          if (q === undefined || q === null) throw new ApiError(400, 'Квота: число гигабайт, например 500');
          const login = form.get('login') ?? '';
          await api.update(login, { quotaBytes: q });
          await api.resolveRequest(m[1]);
          ok(`Квота для ${login} обновлена, просьба закрыта`);
        } else {
          await api.resolveRequest(m[1]);
          ok('Просьба закрыта');
        }
      } else {
        return send(res, 404, 'text/plain; charset=utf-8', 'Нет такой страницы');
      }
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      session.flash = { kind: 'error', text: e.message };
    }
    return redirect(res, '/storage');
  }

  // Раздача альбомов. Ошибки сервера (например «нет такого человека») показываются как есть.
  async function sharingAction(session, res, path, form) {
    const ok = (text) => { session.flash = { kind: 'ok', text }; };
    try {
      let m;
      if (path === '/sharing/everything') {
        if ((form.get('word') ?? '').trim().toLowerCase() !== 'раздать') throw new ApiError(400, 'Чтобы раздать всё, впишите слово «раздать»');
        const r = await api.shareEverything();
        ok(`Готово: альбомов ${r.albums}, новых доступов открыто: ${r.links}`);
      } else if ((m = /^\/sharing\/(\d{1,18})\/(add|remove|all|hide)$/.exec(path))) {
        const login = form.get('login') ?? '';
        if (m[2] === 'add') { await api.share(m[1], login); ok(`Альбом открыт: ${login}`); }
        else if (m[2] === 'remove') { await api.unshare(m[1], login); ok(`Доступ закрыт: ${login}`); }
        else if (m[2] === 'hide') { const r = await api.unshareAll(m[1]); ok(`Альбом скрыт у всех, снято доступов: ${r.removed}`); }
        else { const r = await api.shareAll(m[1]); ok(`Альбом открыт всем, новых доступов: ${r.added}`); }
      } else {
        return send(res, 404, 'text/plain; charset=utf-8', 'Нет такой страницы');
      }
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      session.flash = { kind: 'error', text: e.message };
    }
    return redirect(res, '/sharing');
  }

  // Миниатюра или файл целиком: берётся с внутреннего порта и отдаётся как есть (Range для перемотки видео).
  async function proxyFile(req, res, id, what) {
    let r;
    try {
      r = await api.raw(`/internal/browse/files/${id}/${what}`, req.headers.range);
    } catch {
      return send(res, 502, 'text/plain; charset=utf-8', 'Сервер DVCloud недоступен');
    }
    if (!r.ok && r.status !== 206) return send(res, r.status === 404 ? 404 : 502, 'text/plain; charset=utf-8', r.status === 404 ? 'Нет такого файла или миниатюры' : 'Ошибка сервера');
    const head = { 'content-type': r.headers.get('content-type') ?? 'application/octet-stream', ...SECURITY_HEADERS, 'cache-control': what === 'thumb' ? 'private, max-age=3600' : 'no-store' };
    for (const h of ['content-length', 'content-range', 'accept-ranges']) if (r.headers.get(h)) head[h] = r.headers.get(h);
    res.writeHead(r.status, head);
    if (!r.body) return res.end();
    const { Readable } = await import('node:stream');
    const body = Readable.fromWeb(r.body);
    res.on('close', () => body.destroy());
    body.on('error', () => res.destroy());
    body.pipe(res);
  }

  // Резервная копия. Значения проверяет сервер DVCloud, его текст ошибки показывается как есть.
  async function backupAction(session, res, path, form) {
    try {
      if (path === '/backup/folder') {
        await api.saveBackup({ kind: 'folder', folder: (form.get('folder') ?? '').trim() });
        session.flash = { kind: 'ok', text: 'Выбрано: диск или папка' };
      } else if (path === '/backup/ssh') {
        const port = Number(form.get('port') ?? '22');
        await api.saveBackup({ kind: 'ssh', host: (form.get('host') ?? '').trim(), port, user: (form.get('user') ?? '').trim(), path: (form.get('path') ?? '').trim() });
        session.flash = { kind: 'ok', text: 'Выбрано: другой сервер по SSH. Добавьте открытый ключ на сервер назначения и нажмите «Проверить место»' };
      } else if (path === '/backup/options') {
        const on = (k) => form.get(k) === '1';
        await api.saveBackup({
          withFiles: on('withFiles'), withDb: on('withDb'), withTrash: on('withTrash'), withDerived: on('withDerived'),
          mirror: on('mirror'), readable: on('readable'), withAlbums: on('withAlbums'),
          folders: form.get('folders') ?? 'year', names: form.get('names') ?? 'original', limitMbit: Number(form.get('limitMbit') || 0),
        });
        session.flash = { kind: 'ok', text: 'Настройки копии сохранены' };
      } else if (path === '/backup/check') {
        const r = await api.checkBackup();
        session.flash = { kind: 'ok', text: `Место доступно: ${r.where}${r.freeBytes === null ? '' : `, свободно ${formatSize(r.freeBytes)}`}` };
      } else if (path === '/backup/start') {
        await api.startBackup();
        session.flash = { kind: 'ok', text: 'Копирование запущено. Ход виден ниже, страница обновляется сама' };
      } else {
        return send(res, 404, 'text/plain; charset=utf-8', 'Нет такой страницы');
      }
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      session.flash = { kind: 'error', text: e.message };
    }
    return redirect(res, '/backup');
  }

  async function doAction(session, req, res, path, form) {
    if (path.startsWith('/storage/')) return storageAction(session, res, path, form);
    if (path.startsWith('/media/')) return mediaAction(session, res, path, form);
    if (path.startsWith('/sharing/')) return sharingAction(session, res, path, form);
    if (path.startsWith('/backup/')) return backupAction(session, res, path, form);
    const m = /^\/users\/([a-z0-9_]{2,32})\/(disable|enable|quota|reset|reset2fa|delete)$/.exec(path);
    try {
      if (path === '/users') {
        const r = await api.create(form.get('login') ?? '', form.get('displayName') ?? '');
        return html(res, 200, secretPage({ title: 'Человек создан', login: r.user.login, password: r.password ?? '(задан вручную)' }));
      }
      if (!m) return send(res, 404, 'text/plain; charset=utf-8', 'Нет такой страницы');
      const [, login, action] = m;
      if (action === 'reset') {
        const r = await api.reset(login);
        return html(res, 200, secretPage({ title: 'Пароль сброшен', login, password: r.password }));
      }
      if (action === 'reset2fa') {
        await api.reset2fa(login);
        session.flash = { kind: 'ok', text: `${login}: второй фактор снят, сессии закрыты. Человек настроит его заново после входа.` };
        return redirect(res, '/');
      }
      if (action === 'delete') {
        if ((form.get('confirm') ?? '') !== login) throw new ApiError(400, `Для удаления введите логин «${login}» в поле рядом с кнопкой`);
        const r = await api.deleteUser(login, form.get('force') === '1');
        session.flash = { kind: 'ok', text: `${login}: аккаунт удалён${r.links ? `, записей файлов убрано: ${r.links} (сами файлы остались на диске без владельца)` : ''}` };
        return redirect(res, '/');
      }
      if (action === 'quota') {
        const q = parseQuotaGb(form.get('quota'));
        if (q === undefined) throw new ApiError(400, 'Квота: число гигабайт (например 500) или пусто для снятия лимита');
        await api.update(login, { quotaBytes: q });
        session.flash = { kind: 'ok', text: `Квота для ${login} обновлена` };
      } else {
        await api.update(login, { disabled: action === 'disable' });
        session.flash = { kind: 'ok', text: `${login}: ${action === 'disable' ? 'отключён, его сессии закрыты' : 'включён'}` };
      }
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      session.flash = { kind: 'error', text: e.message };
    }
    return redirect(res, '/');
  }

  async function handle(req, res) {
    const host = String(req.headers.host ?? '').toLowerCase();
    const port = server.address()?.port;
    if (![`127.0.0.1:${port}`, `localhost:${port}`, ...cfg.extraHosts].includes(host)) {
      return send(res, 400, 'text/plain; charset=utf-8', 'Неверный Host');
    }
    const path = new URL(req.url, 'http://x').pathname;
    if (req.method === 'GET' && path === '/style.css') return send(res, 200, 'text/css; charset=utf-8', CSS, { 'cache-control': 'max-age=300' });
    if (req.method === 'GET' && path === '/health') return send(res, 200, 'application/json', JSON.stringify({ status: 'ok', service: 'dvcloud-admin' }));

    if (path === '/login') {
      if (req.method === 'GET') return html(res, 200, loginPage());
      if (req.method !== 'POST') return send(res, 405, 'text/plain; charset=utf-8', 'Метод не разрешён');
      const ip = req.socket.remoteAddress ?? 'unknown';
      if (perIp.blocked(ip) || overall.blocked('all')) return html(res, 429, loginPage('Слишком много попыток. Подождите 15 минут.'));
      const form = await readForm(req);
      const ok = form && verifyPassword(form.get('password') ?? '', cfg.passwordHash);
      if (!ok) {
        perIp.fail(ip);
        overall.fail('all');
        console.warn('Админка: неудачная попытка входа');
        return html(res, 401, loginPage('Неверный пароль'));
      }
      perIp.reset(ip);
      const s = sessions.create();
      return redirect(res, '/', { 'set-cookie': cookie(s.token, 12 * 3600) });
    }

    const token = parseCookies(req.headers.cookie)[COOKIE];
    const session = sessions.get(token);
    if (!session) return redirect(res, '/login');

    if (req.method === 'GET' && path === '/') {
      const flash = session.flash;
      session.flash = null;
      let users = [];
      let loadError = null;
      try {
        users = await api.list();
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        loadError = e.message;
      }
      return html(res, 200, usersPage({ users, csrf: session.csrf, flash, loadError }));
    }

    let fm;
    if (req.method === 'GET' && (fm = /^\/files\/(\d{1,18})\/(thumb|view)$/.exec(path))) return proxyFile(req, res, fm[1], fm[2] === 'thumb' ? 'thumb' : 'original');

    if (req.method === 'GET' && path === '/files') {
      const flash = session.flash;
      session.flash = null;
      const q = new URL(req.url, 'http://x').searchParams;
      const get = (k) => (q.get(k) ?? '').trim();
      const filter = { login: get('login'), from: get('from'), to: get('to'), q: get('q'), album: get('album'), before: get('before') };
      let data = null;
      let users = [];
      let albums = [];
      let loadError = null;
      try {
        [users, albums] = await Promise.all([api.list(), api.albums()]);
        data = await api.browse({ ...filter, limit: 60 });
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        loadError = e.message;
      }
      return html(res, 200, filesPage({ data, users, albums, filter, csrf: session.csrf, flash, loadError }));
    }

    if (req.method === 'GET' && path === '/sharing') {
      const flash = session.flash;
      session.flash = null;
      let albums = [];
      let users = [];
      let loadError = null;
      try {
        [albums, users] = await Promise.all([api.albums(), api.list()]);
        albums = await Promise.all(albums.map(async (a) => ({ ...a, logins: await api.albumShares(a.id) })));
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        loadError = e.message;
        albums = [];
      }
      return html(res, 200, sharingPage({ albums, users, csrf: session.csrf, flash, loadError }));
    }

    if (req.method === 'GET' && path === '/backup') {
      const flash = session.flash;
      session.flash = null;
      let b = null;
      let loadError = null;
      try {
        b = await api.backup();
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        loadError = e.message;
      }
      return html(res, 200, backupPage({ b, csrf: session.csrf, flash, loadError }));
    }

    if (req.method === 'GET' && path === '/media') {
      const flash = session.flash;
      session.flash = null;
      let media = null;
      let dates = null;
      let loadError = null;
      try {
        [media, dates] = await Promise.all([api.media(), api.dates()]);
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        loadError = e.message;
      }
      return html(res, 200, mediaPage({ media, dates, csrf: session.csrf, flash, loadError }));
    }

    if (req.method === 'GET' && path === '/storage') {
      const flash = session.flash;
      session.flash = null;
      const dedupe = session.dedupe ?? null;
      session.dedupe = null;
      const data = { stats: null, orphans: [], albums: [], requests: [], users: [] };
      let loadError = null;
      try {
        [data.stats, data.orphans, data.albums, data.requests, data.users] = await Promise.all([api.stats(), api.orphans(), api.albums(), api.requests(), api.list()]);
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        loadError = e.message;
      }
      return html(res, 200, storagePage({ ...data, csrf: session.csrf, flash, loadError, dedupe }));
    }

    if (req.method !== 'POST') return send(res, 404, 'text/plain; charset=utf-8', 'Нет такой страницы');
    const form = await readForm(req);
    if (!form || form.get('csrf') !== session.csrf) return send(res, 403, 'text/plain; charset=utf-8', 'Запрос отклонён (защита от подделки запросов)');
    if (path === '/logout') {
      sessions.destroy(token);
      return redirect(res, '/login', { 'set-cookie': cookie('', 0) });
    }
    return doAction(session, req, res, path, form);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error('Админка: внутренняя ошибка:', e instanceof Error ? e.message : e);
      if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'Внутренняя ошибка');
      else res.end();
    });
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const cfg = loadAdminConfig();
    const api = createApi({ baseUrl: cfg.internalUrl, token: cfg.token });
    createAdminApp({ cfg, api }).listen(cfg.port, cfg.host, () => console.log(`DVCloud admin слушает ${cfg.host}:${cfg.port}`));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
