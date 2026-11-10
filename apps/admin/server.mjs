// Админка DV Cloud: люди, квоты, пароли. Слушает только локальный адрес, ходит на внутренний порт сервера.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { ApiError, createApi } from './lib/api.mjs';
import { loadAdminConfig } from './lib/config.mjs';
import { CSS, FACES_JS, FACE_PER, VIEWER_JS, backupPage, dupPage, filePage, filesPage, formatSize, transferConfirmPage, loginPage, mediaPage, datesPage, facePage, facesFragment, facesMergePage, facesPage, parseQuotaGb, secretPage, sharingPage, storagePage, usersPage, vaultPage } from './lib/html.mjs';
import { verifyPassword } from './lib/password.mjs';
import { createLimiter } from './lib/ratelimit.mjs';
import { createSessions } from './lib/sessions.mjs';

const COOKIE = 'dvcloud_admin';
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; connect-src 'self'; object-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
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
    if (size > 64 * 1024) return null; // 100 групп дубликатов с отметками занимают около 10 КБ
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

  // Куда вернуться после действия на вкладке «Дубликаты»: на ту же страницу.
  const dupBack = (form) => `/duplicates?page=${/^\d{1,6}$/.test(form.get('page') ?? '') ? form.get('page') : 1}&per=${form.get('per') === '100' ? 100 : 50}`;

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
      } else if (path === '/storage/duplicates/scan') {
        await api.scanDuplicates();
        ok('Поиск дубликатов запущен в фоне, результат появится через несколько минут. Обновите страницу позже');
        return redirect(res, dupBack(form));
      } else if (path === '/storage/duplicates/apply') {
        // Решения по группам: g = группы, показанные на экране; keep = «номер группы:номер файла», которые отметили «оставить».
        // Кнопка у самой группы шлёт only = номер этой группы.
        const only = (form.get('only') ?? '').trim();
        const groups = form.getAll('g').filter((x) => /^\d{1,18}$/.test(x) && (!only || x === only));
        if (groups.length === 0) throw new ApiError(400, 'Нет групп: обновите страницу');
        const marks = form.getAll('keep').map((x) => x.split(':'));
        const decisions = groups.map((g) => ({ group: g, keep: marks.filter((m) => m[0] === g && /^\d{1,18}$/.test(m[1] ?? '')).map((m) => m[1]) }));
        const r = await api.applyDuplicates(decisions);
        ok(`Решения применяются в фоне, групп: ${r.started}. Ход виден внизу списка`);
        return redirect(res, dupBack(form));
      } else if (path === '/storage/duplicates/merge') {
        const keep = (form.get('keep') ?? '').trim();
        const drop = (form.get('drop') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
        if (!/^\d{1,18}$/.test(keep) || drop.length === 0 || drop.some((x) => !/^\d{1,18}$/.test(x))) throw new ApiError(400, 'Не получилось разобрать группу: обновите страницу');
        const r = await api.mergeDuplicates(keep, drop);
        ok(`Готово: записей людей переключено ${r.merged}, лишних записей убрано ${r.removedFiles}, освобождено ${formatSize(r.bytes)}`);
      } else if ((m = /^\/storage\/albums-deleted\/(\d{1,18})\/(restore|purge)$/.exec(path))) {
        if (m[2] === 'restore') {
          const r = await api.restoreAlbum(m[1]);
          ok(`Альбом возвращён хозяину под названием «${r.name}»`);
        } else {
          await api.purgeAlbum(m[1]);
          ok('Альбом стёрт насовсем. Файлы людей остались');
        }
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
      if (path.startsWith('/storage/duplicates/')) return redirect(res, dupBack(form));
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
      } else if ((m = /^\/sharing\/(\d{1,18})\/set$/.exec(path))) {
        // Флажки: кому альбом открыт. Сравниваем с тем, что есть сейчас, и открываем или закрываем разницу.
        const want = new Set(form.getAll('login').map((x) => x.trim()).filter(Boolean));
        const have = new Set(await api.albumShares(m[1]));
        let opened = 0, closed = 0;
        for (const l of want) if (!have.has(l)) { await api.share(m[1], l); opened++; }
        for (const l of have) if (!want.has(l)) { await api.unshare(m[1], l); closed++; }
        ok(opened + closed === 0 ? 'Доступ не изменился' : `Доступ обновлён: открыто ${opened}, закрыто ${closed}`);
      } else if ((m = /^\/sharing\/(\d{1,18})\/transfer$/.exec(path))) {
        const login = form.get('login') ?? '';
        if (form.get('confirm') !== '1') return redirect(res, `/sharing/${m[1]}/transfer?login=${encodeURIComponent(login)}`);
        const r = await api.transfer(m[1], login, true);
        ok(`Альбом передан: ${login}, файлов: ${r.linked}. У прежнего владельца убраны альбом и записи о ${r.removedFromOwner} файлах (из других его альбомов они тоже пропали); на диске файлы остались`);
      } else if ((m = /^\/sharing\/(\d{1,18})\/vault$/.exec(path))) {
        if (!verifyPassword(form.get('password') ?? '', cfg.passwordHash)) throw new ApiError(403, 'Неверный пароль админки: альбом не тронут');
        const r = await api.toVault(m[1], (form.get('note') ?? '').trim());
        ok(`Альбом в сейфе, файлов: ${r.files}. У владельца его больше нет`);
        return redirect(res, '/vault');
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

  // Сейф: вернуть или стереть только после повторного ввода пароля админки.
  async function vaultAction(session, res, path, form) {
    const ok = (text) => { session.flash = { kind: 'ok', text }; };
    try {
      const m = /^\/vault\/(\d{1,18})\/(return|erase)$/.exec(path);
      if (!m) return send(res, 404, 'text/plain; charset=utf-8', 'Нет такой страницы');
      if (!verifyPassword(form.get('password') ?? '', cfg.passwordHash)) throw new ApiError(403, 'Неверный пароль админки: сейф не тронут');
      if (m[2] === 'return') {
        const login = form.get('login') ?? '';
        const r = await api.vaultReturn(m[1], login);
        ok(`Возвращено человеку ${login}, файлов: ${r.linked}`);
      } else {
        const r = await api.vaultErase(m[1]);
        ok(`Стёрто с диска файлов: ${r.files}${r.kept ? `, осталось у людей: ${r.kept}` : ''}, освобождено ${formatSize(r.bytes)}`);
      }
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      session.flash = { kind: 'error', text: e.message };
    }
    return redirect(res, '/vault');
  }

  // Миниатюра или файл целиком: берётся с внутреннего порта и отдаётся как есть (Range для перемотки видео).
  async function proxyFile(req, res, id, what) {
    let r;
    try {
      r = await api.raw(`/internal/browse/files/${id}/${what === 'download' ? 'original?dl=1' : what}`, req.headers.range);
    } catch {
      return send(res, 502, 'text/plain; charset=utf-8', 'Сервер DVCloud недоступен');
    }
    if (!r.ok && r.status !== 206) return send(res, r.status === 404 ? 404 : 502, 'text/plain; charset=utf-8', r.status === 404 ? 'Нет такого файла или миниатюры' : 'Ошибка сервера');
    const head = { 'content-type': r.headers.get('content-type') ?? 'application/octet-stream', ...SECURITY_HEADERS, 'cache-control': what === 'thumb' || what === 'preview' ? 'private, max-age=600' : 'no-store' };
    for (const h of ['content-length', 'content-range', 'accept-ranges', 'content-disposition']) if (r.headers.get(h)) head[h] = r.headers.get(h);
    res.writeHead(r.status, head);
    if (!r.body) return res.end();
    const { Readable } = await import('node:stream');
    const body = Readable.fromWeb(r.body);
    res.on('close', () => body.destroy());
    body.on('error', () => res.destroy());
    body.pipe(res);
  }

  // Лица: объединить, переименовать, распустить, убрать лицо. Ошибки сервера (например «Такое имя уже есть») показываются как есть.
  async function facesAction(session, res, path, form) {
    const ok = (text) => { session.flash = { kind: 'ok', text }; };
    const id = /^\/faces\/(\d{1,18})\//.exec(path)?.[1];
    let back = '/faces';
    // Выбор групп для слияния хранится в сессии: не сбрасывается ни при прокрутке, ни при смене фильтра.
    const sel = (session.faceSel ??= new Set());
    if (path === '/faces/select') {
      if (form.get('clear') === '1') sel.clear();
      else {
        const x = form.get('id') ?? '';
        if (/^\d{1,18}$/.test(x)) {
          if (form.get('on') === '1') { if (sel.size < 2000) sel.add(x); } else sel.delete(x);
        }
      }
      return send(res, 200, 'application/json', JSON.stringify({ n: sel.size }));
    }
    if (path === '/faces/unselect') {
      sel.delete(form.get('id') ?? '');
      return redirect(res, sel.size > 0 ? '/faces/merge' : '/faces');
    }
    try {
      let m;
      if (path === '/faces/merge') {
        back = '/faces/merge';
        const into = (form.get('into') ?? '').trim();
        const from = form.getAll('from').filter((x) => /^\d{1,18}$/.test(x) && x !== into);
        if (!/^\d{1,18}$/.test(into)) throw new ApiError(400, 'Отметьте группу, которая останется');
        if (from.length === 0) throw new ApiError(400, 'Отметьте хотя бы одну группу, которую нужно влить');
        const r = await api.mergeFaces(into, from);
        ok(`Объединено групп: ${r.merged}`);
        sel.clear();
        back = '/faces';
      } else if (id && (m = /^\/faces\/\d+\/(rename|dissolve|remove-face)$/.exec(path))) {
        back = `/faces/${id}`;
        if (m[1] === 'rename') {
          const name = form.get('clear') === '1' ? null : (form.get('name') ?? '').trim();
          if (name === '') throw new ApiError(400, 'Впишите имя или нажмите «Стереть имя»');
          await api.renameFace(id, name);
          ok(name === null ? 'Имя стёрто' : `Имя сохранено: ${name}`);
        } else if (m[1] === 'dissolve') {
          await api.dissolveFace(id);
          ok('Группа распущена, фото остались');
          back = '/faces';
        } else {
          const det = form.get('det') ?? '';
          if (!/^\d{1,18}$/.test(det)) throw new ApiError(400, 'Не получилось разобрать лицо: обновите страницу');
          await api.removeFace(id, det);
          ok('Лицо убрано из группы и в неё больше не вернётся');
          const off = Number(form.get('offset'));
          const q2 = [];
          if (Number.isInteger(off) && off > 0 && off < 1_000_000) q2.push(`offset=${off}`);
          if (form.get('merge') === '1') q2.push('merge=1');
          if (q2.length) back = `/faces/${id}?${q2.join('&')}`;
        }
      } else {
        return send(res, 404, 'text/plain; charset=utf-8', 'Нет такой страницы');
      }
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      session.flash = { kind: 'error', text: e.message };
    }
    return redirect(res, back);
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
      } else if (path === '/backup/cancel') {
        await api.cancelBackup();
        session.flash = { kind: 'ok', text: 'Останавливаю копирование. Уже скопированное остаётся, в следующий раз копия продолжится с этого места' };
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

  // Даты альбома: сдвинуть всем, поставить всем одну, правка по файлам, убрать из альбома.
  async function datesAction(session, res, path, form) {
    const m = /^\/dates\/(\d{1,18})\/(shift|all|each|remove)$/.exec(path);
    if (!m) return send(res, 404, 'text/plain; charset=utf-8', 'Нет такой страницы');
    const [, id, what] = m;
    const stamp = (v) => String(v ?? '').trim().replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})$/, '$1:00');
    try {
      if (what === 'shift' || what === 'all') {
        const r = await api.setAlbumDates(id, what === 'shift' ? { mode: 'shift', first: stamp(form.get('first')) } : { mode: 'all', at: stamp(form.get('at')) });
        session.flash = { kind: 'ok', text: `Даты изменены у файлов: ${r.changed}` };
      } else if (what === 'each') {
        const items = [];
        for (const [k, v] of form) {
          const t = /^t_(\d{1,18})$/.exec(k);
          if (t && v !== form.get(`o_${t[1]}`)) items.push({ id: t[1], at: stamp(v) });
        }
        if (items.length === 0) throw new ApiError(400, 'Ничего не изменилось');
        const r = await api.setAlbumDates(id, { mode: 'each', items });
        session.flash = { kind: 'ok', text: `Даты изменены у файлов: ${r.changed}` };
      } else {
        const ids = form.getAll('rm').filter((x) => /^\d{1,18}$/.test(x));
        if (ids.length === 0) throw new ApiError(400, 'Отметьте файлы, которые нужно убрать из альбома');
        const r = await api.removeAlbumFiles(id, ids);
        session.flash = { kind: 'ok', text: `Убрано из альбома: ${r.removed}` };
      }
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      session.flash = { kind: 'error', text: e.message };
    }
    return redirect(res, `/dates?album=${id}`);
  }

  async function doAction(session, req, res, path, form) {
    if (path.startsWith('/storage/')) return storageAction(session, res, path, form);
    if (path.startsWith('/media/')) return mediaAction(session, res, path, form);
    if (path.startsWith('/faces/')) return facesAction(session, res, path, form);
    if (path.startsWith('/dates/')) return datesAction(session, res, path, form);
    if (path.startsWith('/sharing/')) return sharingAction(session, res, path, form);
    if (path.startsWith('/vault/')) return vaultAction(session, res, path, form);
    if (path.startsWith('/backup/')) return backupAction(session, res, path, form);
    let fm;
    if ((fm = /^\/files\/(\d{1,18})\/taken$/.exec(path))) {
      try {
        // datetime-local приходит как 2019-06-20T08:30 (время UTC, как показано на странице)
        const v = (form.get('takenAt') ?? '').trim();
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) throw new ApiError(400, 'Дата: год-месяц-день и время');
        await api.setTaken(fm[1], `${v}:00Z`);
        session.flash = { kind: 'ok', text: 'Дата снимка исправлена' };
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        session.flash = { kind: 'error', text: e.message };
      }
      return redirect(res, `/files/${fm[1]}`);
    }
    const m = /^\/users\/([a-z0-9_]{2,32})\/(disable|enable|quota|reset|reset2fa|delete|child|adult)$/.exec(path);
    try {
      if (path === '/users') {
        const r = await api.create(form.get('login') ?? '', form.get('displayName') ?? '', form.get('isChild') === '1');
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
      if (action === 'child' || action === 'adult') {
        await api.update(login, { isChild: action === 'child' });
        session.flash = { kind: 'ok', text: `${login}: ${action === 'child' ? 'теперь детский аккаунт' : 'детский режим снят'}` };
      } else if (action === 'quota') {
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
    if (req.method === 'GET' && path === '/viewer.js') return send(res, 200, 'text/javascript; charset=utf-8', VIEWER_JS, { 'cache-control': 'max-age=300' });
    if (req.method === 'GET' && path === '/faces.js') return send(res, 200, 'text/javascript; charset=utf-8', FACES_JS, { 'cache-control': 'max-age=300' });
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
    if (req.method === 'GET' && (fm = /^\/files\/(\d{1,18})\/(thumb|view|zoom|download)$/.exec(path))) return proxyFile(req, res, fm[1], fm[2] === 'thumb' ? 'thumb' : fm[2] === 'zoom' ? 'preview' : fm[2] === 'download' ? 'download' : 'original');

    if (req.method === 'GET' && (fm = /^\/files\/(\d{1,18})$/.exec(path))) {
      const flash = session.flash;
      session.flash = null;
      const q = new URL(req.url, 'http://x').searchParams;
      const get = (k) => (q.get(k) ?? '').trim();
      const filter = { login: get('login'), from: get('from'), to: get('to'), q: get('q'), album: get('album') };
      let info = null;
      try {
        info = await api.fileInfo(fm[1], filter);
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        if (e.status === 404) return send(res, 404, 'text/plain; charset=utf-8', 'Нет такого файла');
        session.flash = { kind: 'error', text: e.message };
        return redirect(res, '/files');
      }
      return html(res, 200, filePage({ info, filter, csrf: session.csrf, flash, loadError: null }));
    }

    // Вырезка лица для карточек (с внутреннего порта, как миниатюры файлов)
    if (req.method === 'GET' && (fm = /^\/faces\/crop\/(\d{1,18})$/.exec(path))) {
      let r;
      try {
        r = await api.raw(`/internal/faces/detections/${fm[1]}/crop`);
      } catch {
        return send(res, 502, 'text/plain; charset=utf-8', 'Сервер DVCloud недоступен');
      }
      if (!r.ok) return send(res, r.status === 404 ? 404 : 502, 'text/plain; charset=utf-8', 'Нет вырезки');
      res.writeHead(200, { 'content-type': 'image/webp', ...SECURITY_HEADERS, 'cache-control': 'private, max-age=3600' });
      return res.end(Buffer.from(await r.arrayBuffer()));
    }

    if (req.method === 'GET' && (fm = /^\/faces\/(\d{1,18})$/.exec(path))) {
      const flash = session.flash;
      session.flash = null;
      const sp = new URL(req.url, 'http://x').searchParams;
      const offset = Math.max(0, Math.min(1_000_000, Number(sp.get('offset')) || 0));
      try {
        return html(res, 200, facePage({ data: await api.face(fm[1], offset), offset, csrf: session.csrf, flash, loadError: null, merge: sp.get('merge') === '1' }));
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        session.flash = { kind: 'error', text: e.message };
        return redirect(res, '/faces');
      }
    }

    if (req.method === 'GET' && path === '/dates') {
      const flash = session.flash;
      session.flash = null;
      const albumId = /^\d{1,18}$/.test(new URL(req.url, 'http://x').searchParams.get('album') ?? '') ? new URL(req.url, 'http://x').searchParams.get('album') : '';
      let albums = [];
      let data = null;
      let loadError = null;
      try {
        albums = await api.albums();
        if (albumId) data = await api.albumDates(albumId);
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        loadError = e.message;
      }
      return html(res, 200, datesPage({ albums, data, albumId, csrf: session.csrf, flash, loadError }));
    }

    if (req.method === 'GET' && path === '/faces/merge') {
      const flash = session.flash;
      session.flash = null;
      const sel = (session.faceSel ??= new Set());
      const groups = [];
      for (const id of [...sel]) {
        try {
          groups.push((await api.face(id, 0, 1)).group);
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
          sel.delete(id); // группа уже исчезла (распущена или влита): из выбора убираем
        }
      }
      return html(res, 200, facesMergePage({ groups, csrf: session.csrf, flash, loadError: null }));
    }

    if (req.method === 'GET' && path === '/faces') {
      const flash = session.flash;
      session.flash = null;
      const sp = new URL(req.url, 'http://x').searchParams;
      const q = {
        kind: sp.get('kind') === 'person' || sp.get('kind') === 'pet' ? sp.get('kind') : '',
        q: (sp.get('q') ?? '').trim().slice(0, 60),
        unnamed: sp.get('unnamed') === '1' ? '1' : '',
        page: Math.max(1, Math.min(100000, Number(sp.get('page')) || 1)),
      };
      let data = null;
      let loadError = null;
      try {
        data = await api.faces({ ...(q.kind ? { kind: q.kind } : {}), ...(q.q ? { q: q.q } : {}), ...(q.unnamed ? { unnamed: '1' } : {}), offset: String((q.page - 1) * FACE_PER), limit: String(FACE_PER) });
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        loadError = e.message;
      }
      const sel = session.faceSel ?? new Set();
      if (sp.get('frag') === '1') {
        // Подгрузка при прокрутке: только карточки; заголовок X-More говорит, есть ли ещё страницы.
        if (!data) return send(res, 502, 'text/plain; charset=utf-8', loadError ?? 'Не загрузилось');
        return send(res, 200, 'text/html; charset=utf-8', facesFragment({ data, sel }), { 'x-more': q.page * FACE_PER < data.total ? '1' : '0' });
      }
      return html(res, 200, facesPage({ data, q, csrf: session.csrf, flash, loadError, sel }));
    }

    if (req.method === 'GET' && path === '/duplicates') {
      const flash = session.flash;
      session.flash = null;
      const q = new URL(req.url, 'http://x').searchParams;
      const per = q.get('per') === '100' ? 100 : 50;
      const page = Math.max(1, Math.min(100000, Number(q.get('page')) || 1));
      let report = null;
      let loadError = null;
      try {
        report = await api.duplicates((page - 1) * per, per);
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        loadError = e.message;
      }
      return html(res, 200, dupPage({ report, page, per, csrf: session.csrf, flash, loadError }));
    }

    if (req.method === 'GET' && (fm = /^\/sharing\/(\d{1,18})\/transfer$/.exec(path))) {
      const login = (new URL(req.url, 'http://x').searchParams.get('login') ?? '').trim();
      try {
        const [albums, preview] = await Promise.all([api.albums(), api.transferPreview(fm[1])]);
        const album = albums.find((a) => a.id === fm[1]);
        if (!album || !login) throw new ApiError(404, 'Альбом или человек не найден');
        const flash = session.flash;
        session.flash = null;
        return html(res, 200, transferConfirmPage({ album, login, preview, csrf: session.csrf, flash, loadError: null }));
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        session.flash = { kind: 'error', text: e.message };
        return redirect(res, '/sharing');
      }
    }

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
      const sp = new URL(req.url, 'http://x').searchParams;
      return html(res, 200, sharingPage({ albums, users, csrf: session.csrf, flash, loadError, filter: { owner: sp.get('owner') ?? '', kind: sp.get('kind') ?? '', q: sp.get('q') ?? '' } }));
    }

    if (req.method === 'GET' && path === '/vault') {
      const flash = session.flash;
      session.flash = null;
      let albums = [];
      let users = [];
      let loadError = null;
      try {
        [albums, users] = await Promise.all([api.vault(), api.list()]);
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        loadError = e.message;
      }
      return html(res, 200, vaultPage({ albums, users, csrf: session.csrf, flash, loadError }));
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
      const data = { stats: null, orphans: [], albums: [], deletedAlbums: [], requests: [], users: [] };
      let loadError = null;
      try {
        [data.stats, data.orphans, data.albums, data.deletedAlbums, data.requests, data.users] = await Promise.all([api.stats(), api.orphans(), api.albums(), api.deletedAlbums(), api.requests(), api.list()]);
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
