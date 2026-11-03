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
:root { color-scheme: light dark; --bg:#f6f7f9; --fg:#1d2330; --card:#fff; --line:#d9dde5; --acc:#2456d6; --bad:#b3261e; --ok:#17692b; }
@media (prefers-color-scheme: dark) { :root { --bg:#14171d; --fg:#e6e9ef; --card:#1d222b; --line:#323946; --acc:#7da2ff; --bad:#ff8a80; --ok:#7bd88f; } }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.45 system-ui, sans-serif; }
main { max-width:980px; margin:0 auto; padding:24px 16px 48px; }
h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:17px; margin:28px 0 8px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:14px 16px; margin:12px 0; }
.msg { padding:10px 14px; border-radius:8px; border:1px solid var(--line); margin:12px 0; }
.msg.ok { border-color:var(--ok); } .msg.error { border-color:var(--bad); color:var(--bad); }
table { width:100%; border-collapse:collapse; } th,td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--line); vertical-align:middle; }
th { font-weight:600; font-size:13px; opacity:.75; }
form.inline { display:inline-flex; gap:6px; align-items:center; margin:2px 6px 2px 0; }
input[type=text], input[type=password] { padding:7px 9px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); font:inherit; }
input.narrow { width:90px; }
button { padding:7px 12px; border:1px solid var(--acc); border-radius:6px; background:transparent; color:var(--acc); font:inherit; cursor:pointer; }
button.primary { background:var(--acc); color:#fff; } button.danger { border-color:var(--bad); color:var(--bad); }
.secret { font:20px/1.3 ui-monospace, monospace; padding:12px; border:1px dashed var(--acc); border-radius:8px; user-select:all; word-break:break-all; }
.muted { opacity:.7; font-size:13px; } .off { opacity:.55; }
header { display:flex; justify-content:space-between; align-items:center; }
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

function userRow(u, csrf) {
  const login = esc(u.login);
  const act = (path, label, cls = '', extra = '') =>
    `<form class="inline" method="post" action="/users/${encodeURIComponent(u.login)}/${path}">${csrfInput(csrf)}${extra}<button class="${cls}" type="submit">${label}</button></form>`;
  const quotaGb = u.quotaBytes === null ? '' : (u.quotaBytes / GIB).toFixed(u.quotaBytes % GIB === 0 ? 0 : 1);
  return `<tr class="${u.disabled ? 'off' : ''}">
<td><b>${login}</b></td><td>${esc(u.displayName)}</td><td>${u.disabled ? 'отключён' : 'активен'}</td><td>${esc(formatQuota(u.quotaBytes))}</td><td>${u.twoFactor ? 'включена' : '—'}</td>
<td>${act(u.disabled ? 'enable' : 'disable', u.disabled ? 'Включить' : 'Отключить', u.disabled ? '' : 'danger')}
${act('quota', 'Квота', '', `<input class="narrow" type="text" name="quota" value="${esc(quotaGb)}" placeholder="ГБ" aria-label="Квота, ГБ">`)}
${act('reset', 'Сбросить пароль', 'danger')}
${u.twoFactor ? act('reset2fa', 'Сбросить 2FA', 'danger') : ''}</td></tr>`;
}

export function usersPage({ users, csrf, flash, loadError }) {
  const rows = users.map((u) => userRow(u, csrf)).join('\n');
  return layout('DV Cloud: люди', `
<header><div><h1>DV Cloud: люди</h1><div class="muted">Пароль показывается один раз при создании и сбросе.</div></div>
<form method="post" action="/logout">${csrfInput(csrf)}<button type="submit">Выйти</button></form></header>
${flash ? `<div class="msg ${flash.kind === 'error' ? 'error' : 'ok'}">${esc(flash.text)}</div>` : ''}
${loadError ? `<div class="msg error">${esc(loadError)}</div>` : ''}
<table><thead><tr><th>Логин</th><th>Имя</th><th>Состояние</th><th>Квота</th><th>2FA</th><th>Действия</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6" class="muted">Людей пока нет.</td></tr>'}</tbody></table>
<h2>Новый человек</h2>
<form method="post" action="/users" class="card">${csrfInput(csrf)}
  <p><input type="text" name="login" placeholder="логин (a-z, 0-9, _)" pattern="[a-z0-9_]{2,32}" required>
     <input type="text" name="displayName" placeholder="имя" maxlength="64" required></p>
  <button class="primary" type="submit">Создать</button>
</form>`);
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
