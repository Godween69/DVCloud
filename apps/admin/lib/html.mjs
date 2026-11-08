// Страницы админки. Всё, что пришло извне (имена, сообщения), проходит через esc().
export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const GIB = 1024 ** 3;

export function formatQuota(bytes) {
  if (bytes === null || bytes === undefined) return 'без лимита';
  return `${(bytes / GIB).toFixed(bytes % GIB === 0 ? 0 : 1).replace('.', ',')} ГБ`;
}

// Поле формы "ГБ" -> байты. Пусто = без лимита (null). Ошибка = undefined.
export function parseQuotaGb(text) {
  const t = String(text ?? '').trim().replace(',', '.');
  if (t === '') return null;
  if (!/^\d{1,6}(\.\d{1,3})?$/.test(t)) return undefined;
  return Math.round(Number(t) * GIB);
}

export const CSS = `
:root { color-scheme: light dark; --bg:#eef1f5; --fg:#18202b; --mut:#5d6878; --card:#ffffff; --line:#dbe1ea; --soft:#f3f5f9; --acc:#2d5bd0; --acc-fg:#ffffff; --bad:#b3261e; --ok:#17692b; --warn:#9a5b00; --shadow:0 1px 2px rgba(20,30,50,.06), 0 6px 20px rgba(20,30,50,.06); }
@media (prefers-color-scheme: dark) { :root { --bg:#0e1218; --fg:#e7ebf2; --mut:#98a3b5; --card:#171c25; --line:#2a3240; --soft:#1e2531; --acc:#86a8ff; --acc-fg:#0e1218; --bad:#ff8a80; --ok:#7bd88f; --warn:#f0b35a; --shadow:0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.35); } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; font-variant-numeric:tabular-nums; }
main { max-width:1040px; margin:0 auto; padding:20px 16px 56px; }
a { color:var(--acc); }
h1 { font-size:22px; margin:0; letter-spacing:-.01em; }
h2 { font-size:17px; margin:0 0 4px; }
p { margin:6px 0; }
.muted { color:var(--mut); font-size:13px; }
.bar { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:18px; }
.brand { display:flex; align-items:baseline; gap:10px; }
.brand b { font-size:18px; letter-spacing:-.01em; }
nav.tabs { display:inline-flex; gap:2px; padding:3px; background:var(--soft); border:1px solid var(--line); border-radius:999px; }
nav.tabs a { padding:7px 16px; border-radius:999px; color:var(--mut); text-decoration:none; font-weight:500; }
nav.tabs a:hover { color:var(--fg); }
nav.tabs a[aria-current] { background:var(--card); color:var(--fg); box-shadow:0 1px 3px rgba(20,30,50,.18); }
nav.tabs a:focus-visible, .btn:focus-visible, summary:focus-visible, input:focus-visible, select:focus-visible { outline:2px solid var(--acc); outline-offset:2px; }
.panel, .card { background:var(--card); border:1px solid var(--line); border-radius:14px; box-shadow:var(--shadow); padding:18px 20px; margin:0 0 18px; }
.card { padding:16px 18px; margin:12px 0 18px; }
.panel > header, .panel-head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap; margin-bottom:10px; }
.msg { padding:10px 14px; border-radius:10px; border:1px solid var(--line); background:var(--card); margin:0 0 16px; }
.msg.ok { border-color:var(--ok); } .msg.error { border-color:var(--bad); color:var(--bad); }
.summary { display:flex; flex-wrap:wrap; gap:8px 28px; }
.summary div { min-width:110px; } .summary b { display:block; font-size:20px; letter-spacing:-.01em; } .summary span { color:var(--mut); font-size:13px; }
table { width:100%; border-collapse:collapse; } th,td { text-align:left; padding:9px 8px; border-bottom:1px solid var(--line); vertical-align:middle; }
tr:last-child td { border-bottom:0; }
th { font-weight:600; font-size:13px; color:var(--mut); }
form.inline { display:inline-flex; gap:6px; align-items:center; margin:2px 6px 2px 0; flex-wrap:wrap; }
input[type=text], input[type=password], input[type=number], select { padding:8px 10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); font:inherit; max-width:100%; }
input.narrow { width:92px; }
.btn, button { padding:8px 14px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--fg); font:inherit; cursor:pointer; text-decoration:none; display:inline-block; }
.btn:hover, button:hover { border-color:var(--acc); }
button.primary, .btn.primary { background:var(--acc); border-color:var(--acc); color:var(--acc-fg); font-weight:600; }
button.danger, .btn.danger { color:var(--bad); } button.danger:hover { border-color:var(--bad); }
button.ghost { background:transparent; }
.secret { font:20px/1.3 ui-monospace, monospace; padding:12px; border:1px dashed var(--acc); border-radius:10px; user-select:all; word-break:break-all; }
.off { opacity:.6; }
/* Люди: строки с аватаром, полосой квоты и меню действий */
.people { list-style:none; margin:0; padding:0; }
.person { display:grid; grid-template-columns:44px minmax(150px,1.2fr) minmax(170px,1.6fr) auto; gap:6px 16px; align-items:center; padding:12px 4px; border-bottom:1px solid var(--line); }
.person:last-child { border-bottom:0; }
.av { width:44px; height:44px; border-radius:50%; display:grid; place-items:center; font-weight:700; font-size:18px; color:#fff; text-transform:uppercase; }
.av0 { background:#3d6fe0; } .av1 { background:#1f9d78; } .av2 { background:#c0541f; } .av3 { background:#8a52c9; } .av4 { background:#c1396b; } .av5 { background:#5b7083; }
.who b { display:block; line-height:1.25; } .who span { color:var(--mut); font-size:13px; }
.chips { display:flex; gap:6px; flex-wrap:wrap; margin-top:3px; }
.chip { font-size:12px; padding:1px 9px; border-radius:999px; background:var(--soft); border:1px solid var(--line); color:var(--mut); }
.chip.ok { color:var(--ok); border-color:var(--ok); background:transparent; } .chip.bad { color:var(--bad); border-color:var(--bad); background:transparent; }
.quota small { display:block; color:var(--mut); font-size:13px; margin-bottom:3px; }
meter { width:100%; height:8px; border-radius:6px; appearance:none; -webkit-appearance:none; background:var(--soft); border:0; }
meter::-webkit-meter-bar { background:var(--soft); border-radius:6px; height:8px; border:1px solid var(--line); }
meter::-webkit-meter-optimum-value, meter::-webkit-meter-suboptimum-value { background:var(--acc); border-radius:6px; }
meter::-webkit-meter-even-less-good-value { background:var(--bad); border-radius:6px; }
meter::-moz-meter-bar { background:var(--acc); border-radius:6px; }
meter:-moz-meter-sub-optimum::-moz-meter-bar { background:var(--warn); } meter:-moz-meter-sub-sub-optimum::-moz-meter-bar { background:var(--bad); }
progress { width:100%; height:8px; appearance:none; -webkit-appearance:none; border:0; border-radius:6px; background:var(--soft); }
progress::-webkit-progress-bar { background:var(--soft); border-radius:6px; border:1px solid var(--line); }
progress::-webkit-progress-value { background:var(--ok); border-radius:6px; } progress::-moz-progress-bar { background:var(--ok); border-radius:6px; }
/* меню «⋯» на раскрывающемся блоке, без скриптов */
.menu { position:relative; }
.menu > summary { list-style:none; cursor:pointer; width:40px; height:40px; border-radius:10px; display:grid; place-items:center; font-size:22px; line-height:1; color:var(--mut); border:1px solid transparent; user-select:none; }
.menu > summary::-webkit-details-marker { display:none; }
.menu > summary:hover, .menu[open] > summary { background:var(--soft); border-color:var(--line); color:var(--fg); }
.menu[open] > summary::before { content:""; position:fixed; inset:0; z-index:5; cursor:default; }
.menu .pop { position:absolute; right:0; top:46px; z-index:6; width:min(320px, 86vw); background:var(--card); border:1px solid var(--line); border-radius:12px; box-shadow:var(--shadow); padding:8px; }
.pop form { margin:0; padding:8px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.pop form + form { border-top:1px solid var(--line); }
.pop form button { flex:1 1 auto; text-align:left; } .pop label { font-size:13px; color:var(--mut); display:flex; gap:6px; align-items:center; }
.pop .h { padding:6px 8px 2px; font-size:12px; color:var(--mut); }
.add > summary { list-style:none; cursor:pointer; } .add > summary::-webkit-details-marker { display:none; }
.add[open] > summary { display:none; }
.add form { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:8px; }
/* Медиа: настройки строками «название, пояснение, поле» */
.setting { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:4px 20px; align-items:center; padding:12px 0; border-bottom:1px solid var(--line); }
.setting:last-of-type { border-bottom:0; }
.setting b { display:block; } .setting .muted { margin:0; }
.switch { display:inline-flex; align-items:center; gap:10px; cursor:pointer; }
.switch input { appearance:none; -webkit-appearance:none; width:44px; height:26px; border-radius:999px; background:var(--line); position:relative; margin:0; cursor:pointer; transition:background .15s; }
.switch input::after { content:""; position:absolute; top:3px; left:3px; width:20px; height:20px; border-radius:50%; background:#fff; transition:transform .15s; box-shadow:0 1px 2px rgba(0,0,0,.3); }
.switch input:checked { background:var(--acc); } .switch input:checked::after { transform:translateX(18px); }
.stats { display:grid; grid-template-columns:repeat(auto-fit, minmax(230px, 1fr)); gap:12px; }
.stat { background:var(--soft); border:1px solid var(--line); border-radius:12px; padding:12px 14px; display:flex; flex-direction:column; gap:6px; }
.stat b { font-size:18px; } .stat form { margin:4px 0 0; }
@media (max-width:720px) {
  .person { grid-template-columns:44px 1fr auto; } .person .quota { grid-column:1 / -1; order:3; }
  .setting { grid-template-columns:1fr; }
  table, thead, tbody, tr, th, td { display:block; } thead { display:none; } tr { padding:8px 0; border-bottom:1px solid var(--line); } td { border:0; padding:3px 0; }
}
@media (prefers-reduced-motion: reduce) { .switch input, .switch input::after { transition:none; } }
`;

const layout = (title, body) => `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="/style.css"></head>
<body><main>${body}</main></body></html>`;

const csrfInput = (csrf) => `<input type="hidden" name="csrf" value="${esc(csrf)}">`;

export function loginPage(error) {
  return layout('DV Cloud: вход', `
<h1>DV Cloud: админка</h1><p class="muted">Только для администратора.</p>
${error ? `<div class="msg error">${esc(error)}</div>` : ''}
<form method="post" action="/login" class="card">
  <p><input type="password" name="password" placeholder="Пароль" autocomplete="current-password" autofocus required></p>
  <button class="primary" type="submit">Войти</button>
</form>`);
}

const TABS = [['users', '/', 'Люди'], ['storage', '/storage', 'Хранилище'], ['media', '/media', 'Медиа']];
const nav = (current) => `<nav class="tabs" aria-label="Разделы">${TABS.map(([k, href, label]) => `<a href="${href}"${current === k ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;
const topBar = (current, csrf) => `<div class="bar"><div class="brand"><b>DV Cloud</b><span class="muted">админка</span></div>${nav(current)}
<form method="post" action="/logout">${csrfInput(csrf)}<button type="submit" class="ghost">Выйти</button></form></div>`;
const flashHtml = (flash, loadError) => `${flash ? `<div class="msg ${flash.kind === 'error' ? 'error' : 'ok'}">${esc(flash.text)}</div>` : ''}${loadError ? `<div class="msg error">${esc(loadError)}</div>` : ''}`;
export function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? Math.round(v) : v.toFixed(1).replace('.', ',')} ${units[i]}`;
}

const post = (csrf, action, fields, label, cls = '', extra = '') =>
  `<form class="inline" method="post" action="${esc(action)}">${csrfInput(csrf)}${Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}${extra}<button class="${cls}" type="submit">${label}</button></form>`;


// Цвет аватара зависит от логина, чтобы у человека он всегда был один и тот же.
const avatarClass = (login) => `av${[...String(login)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 6}`;

function userRow(u, csrf) {
  const login = esc(u.login);
  const act = (path, label, cls = '', extra = '') =>
    `<form method="post" action="/users/${encodeURIComponent(u.login)}/${path}">${csrfInput(csrf)}${extra}<button class="${cls}" type="submit">${label}</button></form>`;
  const quotaGb = u.quotaBytes === null ? '' : (u.quotaBytes / GIB).toFixed(u.quotaBytes % GIB === 0 ? 0 : 1);
  const used = Number(u.usedBytes ?? 0);
  const meter = u.quotaBytes ? `<meter min="0" max="${u.quotaBytes}" low="${Math.floor(u.quotaBytes * 0.85)}" high="${Math.floor(u.quotaBytes * 0.9)}" optimum="0" value="${Math.min(used, u.quotaBytes)}" aria-label="Занято ${esc(formatSize(used))} из ${esc(formatQuota(u.quotaBytes))}"></meter>` : '';
  return `<li class="person${u.disabled ? ' off' : ''}">
<div class="av ${avatarClass(u.login)}" aria-hidden="true">${esc([...String(u.displayName || u.login)][0] ?? '?')}</div>
<div class="who"><b>${esc(u.displayName)}</b><span>${login}</span><div class="chips">${u.disabled ? '<span class="chip bad">отключён</span>' : '<span class="chip ok">активен</span>'}${u.twoFactor ? '<span class="chip ok">2FA включена</span>' : ''}${u.isAdmin ? '<span class="chip">админ</span>' : ''}</div></div>
<div class="quota"><small>${esc(formatSize(used))} из ${esc(formatQuota(u.quotaBytes))}</small>${meter}</div>
<details class="menu"><summary aria-label="Действия: ${login}" title="Действия">⋯</summary><div class="pop">
<div class="h">Квота</div>
${act('quota', 'Сохранить', '', `<input class="narrow" type="text" name="quota" value="${esc(quotaGb)}" placeholder="ГБ" aria-label="Квота, ГБ"><span class="muted">пусто: без лимита</span>`)}
<div class="h">Доступ</div>
${act(u.disabled ? 'enable' : 'disable', u.disabled ? 'Включить' : 'Отключить', u.disabled ? '' : 'danger')}
${act('reset', 'Сбросить пароль', 'danger')}
${u.twoFactor ? act('reset2fa', 'Сбросить 2FA', 'danger') : ''}
<div class="h">Удаление</div>
${act('delete', 'Удалить', 'danger', `<input class="narrow" type="text" name="confirm" placeholder="логин" aria-label="Для удаления введите логин ${login}" autocomplete="off"><label><input type="checkbox" name="force" value="1"> с файлами</label>`)}
</div></details></li>`;
}

export function usersPage({ users, csrf, flash, loadError }) {
  const rows = users.map((u) => userRow(u, csrf)).join('\n');
  return layout('DV Cloud: люди', `
${topBar('users', csrf)}
${flashHtml(flash, loadError)}
<section class="panel">
<div class="panel-head"><div><h2>Люди</h2><p class="muted">Пароль показывается один раз при создании и сбросе.</p></div>
<details class="add"><summary class="btn primary">Добавить человека</summary>
<form method="post" action="/users">${csrfInput(csrf)}
<input type="text" name="login" placeholder="логин (a-z, 0-9, _)" pattern="[a-z0-9_]{2,32}" required aria-label="Логин">
<input type="text" name="displayName" placeholder="имя" maxlength="64" required aria-label="Имя">
<button class="primary" type="submit">Создать</button></form></details></div>
<ul class="people">${rows || '<li class="muted">Людей пока нет.</li>'}</ul>
</section>`);
}

export function storagePage({ stats, orphans, albums, requests, users, csrf, flash, loadError, dedupe }) {
  const logins = users.map((u) => u.login);
  const pick = (name) => `<select name="${name}" aria-label="Кому">${logins.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join('')}</select>`;
  const reqRows = requests.map((r) => `<tr><td><b>${esc(r.login)}</b> <span class="muted">${esc(r.displayName)}</span></td><td>${esc(formatSize(r.needBytes))}</td><td>${esc(formatSize(r.usedBytes))} из ${esc(formatQuota(r.quotaBytes))}</td><td>${esc(r.note || '—')}</td>
<td>${post(csrf, `/storage/requests/${encodeURIComponent(r.id)}/grant`, { login: r.login }, 'Задать квоту', '', '<input class="narrow" type="text" name="quota" placeholder="ГБ" aria-label="Новая квота, ГБ" required>')}
${post(csrf, `/storage/requests/${encodeURIComponent(r.id)}/resolve`, {}, 'Закрыть без изменений')}</td></tr>`).join('');
  const orphanRows = orphans.map((o) => `<tr><td>${esc(o.name)}</td><td>${esc(formatSize(o.size))}</td><td>${esc(o.createdAt.slice(0, 10))}</td>
<td>${post(csrf, `/storage/files/${encodeURIComponent(o.id)}/adopt`, {}, 'Отдать', '', pick('login'))}
${post(csrf, `/storage/files/${encodeURIComponent(o.id)}/purge`, {}, 'Стереть с диска', 'danger')}</td></tr>`).join('');
  const albumRows = albums.map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.owner)}</td><td>${a.count}</td><td>${a.sharedWith || '—'}</td>
<td>${post(csrf, `/storage/albums/${encodeURIComponent(a.id)}/transfer`, {}, 'Скопировать', '', pick('login'))}
${post(csrf, `/storage/albums/${encodeURIComponent(a.id)}/delete`, {}, 'Удалить', 'danger')}</td></tr>`).join('');
  return layout('DV Cloud: хранилище', `
${topBar('storage', csrf)}
${flashHtml(flash, loadError)}
${stats ? `<section class="panel"><div class="summary"><div><b>${stats.files}</b><span>записей людей</span></div><div><b>${stats.blobs}</b><span>файлов на диске</span></div><div><b>${esc(formatSize(stats.bytes))}</b><span>занято на диске</span></div><div><b>${stats.orphans}</b><span>без владельца</span></div><div><b>${stats.extraCopies}</b><span>лишних копий</span></div></div></section>` : ''}

<section class="panel"><h2>Просьбы о месте</h2>
<table><thead><tr><th>Кто</th><th>Нужно</th><th>Сейчас</th><th>Комментарий</th><th>Действия</th></tr></thead>
<tbody>${reqRows || '<tr><td colspan="5" class="muted">Просьб нет.</td></tr>'}</tbody></table>

</section>
<section class="panel"><h2>Файлы без владельца</h2>
<p class="muted">Остаются, когда человек убрал файл насовсем или аккаунт удалён. На диске лежат, пока вы их не отдадите или не сотрёте.</p>
<table><thead><tr><th>Файл</th><th>Размер</th><th>Дата</th><th>Действия</th></tr></thead>
<tbody>${orphanRows || '<tr><td colspan="4" class="muted">Таких файлов нет.</td></tr>'}</tbody></table>

</section>
<section class="panel"><h2>Лишние копии на диске</h2>
<p class="muted">Остались от старой версии, когда один файл мог лежать на диске несколько раз. Каждая копия сверяется по SHA-256 перед стиранием.</p>
${dedupe ? `<div class="msg ok">Проверено: ${dedupe.checked}, удалено: ${dedupe.removed}, освобождено: ${esc(formatSize(dedupe.freedBytes))}${dedupe.mismatched.length ? `, не совпали: ${dedupe.mismatched.length}` : ''}</div>` : ''}
<p>${post(csrf, '/storage/dedupe', { apply: '0' }, 'Только проверить')} ${post(csrf, '/storage/dedupe', { apply: '1' }, 'Удалить лишние копии', 'danger')}</p>

</section>
<section class="panel"><h2>Альбомы</h2>
<p class="muted">«Скопировать» создаёт такой же альбом у выбранного человека со ссылками на те же файлы; место на диске не тратится, но идёт в его квоту. «Удалить» убирает только сам альбом (и общий доступ к нему), файлы людей остаются.</p>
<table><thead><tr><th>Альбом</th><th>Владелец</th><th>Файлов</th><th>Общий</th><th>Действия</th></tr></thead>
<tbody>${albumRows || '<tr><td colspan="5" class="muted">Альбомов нет.</td></tr>'}</tbody></table></section>`);
}
const QUALITY_VIDEO = [[23, 'Высокое'], [26, 'Хорошее'], [28, 'Среднее'], [31, 'Экономное'], [34, 'Компактное']];

const TIMEZONES = ['Europe/Kaliningrad', 'Europe/Moscow', 'Europe/Samara', 'Asia/Yekaterinburg', 'Asia/Novosibirsk', 'Asia/Vladivostok', 'Europe/Kyiv', 'Europe/Minsk', 'Europe/London', 'Europe/Berlin', 'Asia/Almaty', 'UTC'];

const datesPanel = (dates, csrf) => {
  const run = (apply, label, cls = '') => `<form class="inline" method="post" action="/media/dates">${csrfInput(csrf)}<input type="hidden" name="apply" value="${apply ? '1' : '0'}"><button class="${cls}" type="submit"${dates?.running ? ' disabled' : ''}>${label}</button></form>`;
  const status = !dates
    ? '<p class="muted">Проверка ещё не запускалась.</p>'
    : `<p>${dates.running ? 'Идёт' : 'Закончено'}: ${dates.apply ? 'пересчёт' : 'проверка'}. Просмотрено ${dates.checked} из ${dates.total}, дат ${dates.apply ? 'исправлено' : 'будет исправлено'}: <b>${dates.changed}</b>.</p>
${dates.running ? `<progress max="${Math.max(dates.total, 1)}" value="${dates.checked}" aria-label="Ход пересчёта"></progress>` : ''}
${dates.examples.length ? `<table><thead><tr><th>Файл</th><th>Было</th><th>Станет</th></tr></thead><tbody>${dates.examples.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.before.replace('T', ' ').slice(0, 16))}</td><td>${esc(x.after.replace('T', ' ').slice(0, 16))}</td></tr>`).join('')}</tbody></table>` : ''}`;
  return `<section class="panel"><div class="panel-head"><div><h2>Даты у загруженных файлов</h2><p class="muted">Облако берёт дату съёмки из метаданных файла (EXIF у фото, время создания у видео), если их нет, из имени файла (например «2020-05-25 18-55-28.jpg»), и только потом из даты изменения. У файлов, загруженных раньше, дата могла быть взята из даты изменения. «Проверить» показывает, сколько дат изменится, и ничего не меняет.</p></div>
<div>${run(false, 'Проверить')}${run(true, 'Пересчитать', 'primary')}</div></div>${status}</section>`;
};

// Состояние ML-службы поиска по смыслу простыми словами.
const mlState = (x) =>
  !x.configured ? 'не подключена к облаку (нет адреса службы в настройках сервера)'
  : !x.up ? 'не отвечает (контейнер ml не запущен или ещё стартует)'
  : !x.modelFiles ? `запущена, но файлов модели нет (${esc(x.model ?? '')}): загрузите их скриптом dvcloud-models.sh`
  : `работает, модель ${esc(x.model ?? '')}`;

const searchPanel = (x, s, csrf) => {
  const clear = (what, label, cls, hint) =>
    `<form class="inline" method="post" action="/media/clear">${csrfInput(csrf)}<input type="hidden" name="what" value="${what}"><button class="${cls}" type="submit" title="${esc(hint)}">${label}</button></form>`;
  return `<section class="panel"><div class="panel-head"><div><h2>Поиск по смыслу</h2><p class="muted">Служба: ${mlState(x)}.</p></div>
<div>${x.failed ? clear('index-failed', 'Повторить неудачные', '', 'Файлы, которые не удалось прочитать, попробуются снова') : ''}${clear('index', 'Пересчитать всё', 'danger', 'Стереть все векторы: они посчитаются заново, это займёт часы')}</div></div>
<p>Готово ${x.ready} из ${x.total}${x.failed ? `, не удалось прочитать: ${x.failed}` : ''}${x.pending ? `, в очереди: ${x.pending}` : ''}. Векторы занимают ${esc(formatSize(x.sizeBytes))} в базе.</p>
<progress max="${Math.max(x.total, 1)}" value="${x.ready + x.failed}" aria-label="Ход построения векторов"></progress>
<p class="muted">${s.searchEnabled ? 'Поиск включён: векторы считаются в фоне, когда нет загрузок, и пока вы не выключите.' : 'Поиск выключен: ничего не считается, строка поиска на сайте скрыта.'}</p></section>`;
};

export function mediaPage({ media, dates, csrf, flash, loadError }) {
  const s = media?.settings;
  const clear = (what, label, hint) =>
    `<form method="post" action="/media/clear">${csrfInput(csrf)}<input type="hidden" name="what" value="${what}"><button class="danger" type="submit" title="${esc(hint)}">${label}</button></form>`;
  const stats = media
    ? `<section class="panel"><div class="panel-head"><div><h2>Что лежит на диске</h2><p class="muted">Это производные файлы. Оригиналы они не затрагивают, всё можно очистить: построится заново.</p></div></div>
<div class="stats">
<div class="stat"><span class="muted">Миниатюры</span><b>${esc(formatSize(media.thumbs.bytes))}</b><span class="muted">${media.thumbs.files} шт., плитки в ленте</span>${clear('thumbs', 'Очистить', 'Построятся при открытии ленты')}</div>
<div class="stat"><span class="muted">Превью фото</span><b>${esc(formatSize(media.previews.bytes))}</b><span class="muted">${media.previews.files} шт., для просмотра на весь экран</span>${clear('previews', 'Очистить', 'Построятся при просмотре')}</div>
<div class="stat"><span class="muted">Копии видео</span><b>${esc(formatSize(media.videos.copies.bytes))}</b><span class="muted">готово ${media.videos.ready} из ${media.videos.total} (оригиналы ${esc(formatSize(media.videos.totalBytes))})</span>
<progress max="${Math.max(media.videos.total, 1)}" value="${media.videos.ready + media.videos.skipped}" aria-label="Готовность копий видео"></progress>
<span class="muted">без выгоды: ${media.videos.skipped}, ошибок: ${media.videos.failed}, в очереди: ${media.videos.pending}</span>${clear('videos', 'Очистить', 'Копии удалятся, очередь начнётся заново')}</div>
</div></section>`
    : '';
  const sw = (name, on, label) => `<label class="switch"><input type="checkbox" name="${name}" value="1"${on ? ' checked' : ''}><span>${label}</span></label>`;
  const crfOptions = QUALITY_VIDEO.some(([v]) => v === s?.videoCrf) ? QUALITY_VIDEO : [...QUALITY_VIDEO, [s?.videoCrf, `Своё (${s?.videoCrf})`]].sort((a, b) => a[0] - b[0]);
  const form = s
    ? `<form method="post" action="/media/settings">${csrfInput(csrf)}
<section class="panel"><h2>Фото</h2>
<div class="setting"><div><b>Превью для просмотра</b><p class="muted">Облегчённая копия, которую сайт открывает вместо оригинала. Выключено: сайт открывает оригинал, скачивание всегда отдаёт оригинал.</p></div>${sw('previewEnabled', s.previewEnabled, 'Использовать')}</div>
<div class="setting"><div><b>Размер превью</b><p class="muted">Длинная сторона в пикселях, от 600 до 4000. Для телефона и ноутбука хватает 1600–2000.</p></div><input class="narrow" type="number" name="previewMaxSide" min="600" max="4000" step="100" value="${s.previewMaxSide}" aria-label="Размер превью, px"></div>
<div class="setting"><div><b>Качество превью</b><p class="muted">От 30 до 95. Выше число: чище картинка и больше файл. Обычно 75–85.</p></div><input class="narrow" type="number" name="previewQuality" min="30" max="95" step="1" value="${s.previewQuality}" aria-label="Качество превью"></div>
</section>
<section class="panel"><h2>Видео</h2>
<div class="setting"><div><b>Копии для просмотра</b><p class="muted">Облако в фоне делает из видео уменьшенную копию (H.264), по одному ролику, с низким приоритетом и только когда нет загрузок. Плеер на сайте берёт копию, а скачивание отдаёт оригинал. Нагружает процессор мини-ПК, поэтому по умолчанию выключено.</p></div>${sw('videoEnabled', s.videoEnabled, 'Делать и использовать')}</div>
<div class="setting"><div><b>Размер кадра копии</b><p class="muted">Высота по вертикали. Кадр не увеличивается: ролик меньше выбранного остаётся как есть по размеру.</p></div><select name="videoHeight" aria-label="Высота кадра">${[480, 720, 1080].map((h) => `<option value="${h}"${h === s.videoHeight ? ' selected' : ''}>${h}p</option>`).join('')}</select></div>
<div class="setting"><div><b>Качество копии</b><p class="muted">Выше качество: лучше картинка, больше файл и дольше работа. Если копия получается не меньше оригинала, она не сохраняется.</p></div><select name="videoCrf" aria-label="Качество видео">${crfOptions.map(([v, l]) => `<option value="${v}"${v === s.videoCrf ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
</section>
<section class="panel"><h2>Поиск по смыслу</h2>
<div class="setting"><div><b>Искать фото и видео по описанию</b><p class="muted">Облако в фоне «просматривает» каждое фото (для видео один кадр) нейросетью и запоминает его смысл, поэтому на сайте можно искать словами: «собака на пляже», «скриншот переписки». Работает по-русски. Фото не покидают ваш мини-ПК. Нагружает процессор часами (разово), поэтому по умолчанию выключено.</p></div>${sw('searchEnabled', s.searchEnabled, 'Включить поиск')}</div>
<div class="setting"><div><b>Строгость выдачи</b><p class="muted">В результатах остаются файлы, которые подходят не хуже этого процента от лучшего совпадения, от 50 до 95. Больше число: короче и точнее выдача. Меньше: больше находок, но и больше лишнего.</p></div><input class="narrow" type="number" name="searchCutoff" min="50" max="95" step="1" value="${s.searchCutoff}" aria-label="Строгость выдачи, проценты"></div>
</section>
<section class="panel"><h2>Даты съёмки</h2>
<div class="setting"><div><b>Часовой пояс</b><p class="muted">В нём записано время в метаданных и в именах файлов (там нет пояса). Для семьи в Москве: Europe/Moscow. Применяется к новым загрузкам и к пересчёту ниже.</p></div><span><input type="text" name="timezone" list="tz" value="${esc(s.timezone)}" maxlength="64" aria-label="Часовой пояс"><datalist id="tz">${TIMEZONES.map((z) => `<option value="${z}">`).join('')}</datalist></span></div>
</section>
<section class="panel"><div class="panel-head"><p class="muted">Смена размера или качества стирает готовые превью и копии: они построятся заново с новыми настройками.</p><button class="primary" type="submit">Сохранить настройки</button></div></section>
</form>`
    : '';
  return layout('DV Cloud: медиа', `
${topBar('media', csrf)}
${flashHtml(flash, loadError)}
${stats}
${media ? searchPanel(media.search, s, csrf) : ''}
${form}
${media ? datesPanel(dates, csrf) : ''}`);
}

export function secretPage({ title, login, password }) {
  return layout(title, `
<h1>${esc(title)}</h1>
<p>Человек: <b>${esc(login)}</b></p>
<p>Пароль (показывается один раз, передай его человеку):</p>
<div class="secret">${esc(password)}</div>
<p class="muted">Эту страницу нельзя открыть повторно. Если пароль потерян, сбрось его заново.</p>
<p><a href="/">К списку людей</a></p>`);
}
