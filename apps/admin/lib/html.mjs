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
:root { color-scheme: light dark; --bg:#eef1f5; --fg:#18202b; --mut:#5d6878; --card:#ffffff; --line:#dbe1ea; --soft:#f3f5f9; --acc:#2d5bd0; --acc-fg:#ffffff; --bad:#b3261e; --ok:#17692b; --warn:#9a5b00; --shadow:0 0 22px -8px rgba(20,30,50,.28); }
@media (prefers-color-scheme: dark) { :root { --bg:#0e1218; --fg:#e7ebf2; --mut:#98a3b5; --card:#171c25; --line:#2a3240; --soft:#1e2531; --acc:#86a8ff; --acc-fg:#0e1218; --bad:#ff8a80; --ok:#7bd88f; --warn:#f0b35a; --shadow:0 0 24px -8px rgba(0,0,0,.6); } }
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
nav.tabs a[aria-current] { background:var(--card); color:var(--fg); box-shadow:0 0 10px -2px rgba(20,30,50,.3); }
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
.dupbar { margin:14px 0 4px; display:flex; flex-wrap:wrap; gap:8px 14px; align-items:center; }
.dupbar p { margin:0; }
.dupconfirm summary { display:inline-block; cursor:pointer; list-style:none; padding:8px 14px; border:1px solid var(--line); border-radius:10px; background:var(--card); }
.dupconfirm summary::-webkit-details-marker { display:none; }
.dupconfirm[open] summary { margin-bottom:8px; }
.dupconfirm form { margin:0; }
/* Приближение без скриптов: зажмите кадр, он вырастает на весь экран; отпустите, он уходит обратно. */
.zoomhold { position:relative; display:block; padding:0; border:0; background:none; cursor:zoom-in; border-radius:8px; -webkit-user-select:none; user-select:none; touch-action:manipulation; }
.zoomhold img { display:block; width:140px; height:140px; object-fit:cover; border-radius:8px; background:rgba(127,127,127,.15); -webkit-user-drag:none; }
.zoombox { display:none; position:fixed; inset:0; z-index:50; pointer-events:none; place-items:center; background:rgba(0,0,0,.72); opacity:0; transition:opacity .2s ease, display .2s allow-discrete; }
.zoombox figure { margin:0; text-align:center; transform:scale(.35); transition:transform .22s ease-out; }
.zoombox img { display:block; max-width:96vw; max-height:88vh; width:auto; height:auto; border-radius:10px; box-shadow:0 12px 50px rgba(0,0,0,.6); background:#111; }
.zoombox figcaption { margin-top:8px; color:#fff; font-size:14px; }
html:not(.js) .zoomhold:active + .zoombox, .zoomhold.hold + .zoombox { display:grid; opacity:1; }
html:not(.js) .zoomhold:active + .zoombox figure, .zoomhold.hold + .zoombox figure { transform:scale(1); }
@starting-style { html:not(.js) .zoomhold:active + .zoombox, .zoomhold.hold + .zoombox { opacity:0; } html:not(.js) .zoomhold:active + .zoombox figure, .zoomhold.hold + .zoombox figure { transform:scale(.35); } }
.dupgroup { border:1px solid var(--line, #2a3144); border-radius:10px; padding:10px 12px; margin:10px 0; }
.faces { list-style:none; margin:0 0 10px; padding:0; display:flex; flex-wrap:wrap; gap:14px; }
.face { width:176px; display:flex; flex-direction:column; gap:6px; padding:8px; border:1px solid var(--line); border-radius:12px; background:var(--soft); }
.facepic img { display:block; width:160px; height:160px; object-fit:cover; border-radius:10px; }
.facemeta { font-size:13px; line-height:1.35; word-break:break-word; }
.facepick { font-size:13px; display:flex; gap:6px; align-items:center; cursor:pointer; }
.dups { list-style:none; margin:0 0 6px; padding:0; display:flex; flex-wrap:wrap; gap:12px; }
.dup { position:relative; width:164px; box-sizing:border-box; padding:6px; border:3px solid var(--bad); border-radius:12px; background:rgba(127,127,127,.08); }
.dup:has(.dupchk:checked) { border-color:var(--ok); }
.dup:has(.dupchk:focus-visible) { outline:2px solid var(--acc); outline-offset:2px; }
.dupchk { position:absolute; opacity:0; width:1px; height:1px; pointer-events:none; }
.dupstrip { display:block; margin-top:6px; padding:9px 4px; text-align:center; border-radius:8px; cursor:pointer; font-weight:600; color:#fff; background:var(--bad); -webkit-user-select:none; user-select:none; }
.dupchk:checked ~ .dupstrip { background:var(--ok); }
.dupstrip .y { display:none; } .dupchk:checked ~ .dupstrip .y { display:inline; } .dupchk:checked ~ .dupstrip .n { display:none; }
.dupmeta { margin-top:5px; font-size:12px; line-height:1.35; }
.pager.top { margin:8px 0 12px; display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.pager .cur { padding:0 6px; color:var(--mut); }
.legend { display:flex; gap:14px; flex-wrap:wrap; margin:4px 0 8px; }
.legend i { display:inline-block; width:14px; height:14px; border-radius:4px; vertical-align:-2px; margin-right:6px; }
.legend .g i { background:var(--ok); } .legend .r i { background:var(--bad); }
/* Просмотр файла */
.fview { display:grid; grid-template-columns:minmax(0,1fr) 320px; gap:18px; align-items:start; }
@media (max-width:900px) { .fview { grid-template-columns:1fr; } }
.stage { background:#0b0d11; border-radius:12px; display:grid; place-items:center; min-height:50vh; padding:8px; }
.stage img, .stage video { display:block; max-width:100%; max-height:78vh; width:auto; height:auto; border-radius:6px; }
.fnav { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin:0 0 12px; }
.fnav .sp { flex:1; }
.facts { display:grid; grid-template-columns:auto 1fr; gap:6px 12px; margin:0 0 12px; font-size:14px; }
.facts dt { color:var(--mut); } .facts dd { margin:0; word-break:break-word; }
.facts code { font-size:11px; word-break:break-all; }
.factions { display:grid; gap:8px; margin-top:10px; }
.factions .btn { text-align:center; }
.btn.off { opacity:.4; pointer-events:none; }
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
@media (prefers-reduced-motion: reduce) { .switch input, .switch input::after, .info .tip, .tile, nav.tabs a, button { transition:none; animation:none; } }

/* ── Вид 0.9: сияние на фоне, стеклянные панели, подсказки «Инфо» ── */
body { background:var(--bg); background-image:radial-gradient(60vmax 60vmax at 0% -10%, var(--aur-a), transparent 70%), radial-gradient(55vmax 55vmax at 105% 110%, var(--aur-b), transparent 70%); background-attachment:fixed; }
:root { --aur-a:rgba(124,92,255,.22); --aur-b:rgba(45,160,210,.18); --glass:rgba(255,255,255,.72); --glass-line:rgba(120,130,160,.22); }
@media (prefers-color-scheme: dark) { :root { --aur-a:rgba(124,92,255,.26); --aur-b:rgba(20,150,190,.2); --glass:rgba(23,28,37,.66); --glass-line:rgba(255,255,255,.1); } }
.panel, .card { background:var(--glass); border-color:var(--glass-line); border-radius:18px; box-shadow:inset 0 1px 0 rgba(255,255,255,.18), var(--shadow); }
nav.tabs { background:var(--glass); flex-wrap:wrap; }
nav.tabs a { transition:background .15s, color .15s; }
nav.tabs a[aria-current] { background:linear-gradient(135deg, var(--acc), #7c5cff); color:#fff; box-shadow:0 0 16px -2px var(--acc); }
button.primary, .btn.primary { background:linear-gradient(135deg, var(--acc), #7c5cff); border-color:transparent; color:#fff; }
.btn, button { transition:border-color .15s, transform .1s, box-shadow .2s; } button:active { transform:scale(.97); }
.btn:hover, button:hover:not(:disabled) { box-shadow:0 0 14px -3px var(--acc); }
button.primary:hover:not(:disabled), .btn.primary:hover { box-shadow:0 0 18px -2px var(--acc); }
button.danger:hover:not(:disabled) { box-shadow:0 0 14px -3px var(--bad); }
h2 { display:flex; align-items:center; gap:8px; }
/* Кнопочка «Инфо»: раскрывающийся блок без скриптов */
.info { position:relative; display:inline-block; vertical-align:middle; }
.info > summary { list-style:none; cursor:pointer; width:22px; height:22px; border-radius:50%; display:grid; place-items:center; font:italic 700 13px/1 Georgia, serif; color:var(--mut); border:1px solid var(--line); user-select:none; background:transparent; }
.info > summary::-webkit-details-marker { display:none; }
.info > summary:hover, .info[open] > summary { color:#fff; background:var(--acc); border-color:var(--acc); }
.info[open] > summary::before { content:""; position:fixed; inset:0; z-index:8; cursor:default; }
.info .tip { position:absolute; left:0; top:30px; z-index:9; width:min(380px, 84vw); padding:12px 14px; border-radius:14px; background:var(--card); border:1px solid var(--line); box-shadow:0 0 30px -6px rgba(0,0,0,.5); font-size:14px; font-weight:400; line-height:1.5; color:var(--fg); text-align:left; animation:dv-pop .16s ease-out; }
.info.right .tip { left:auto; right:0; }
.info .tip p { margin:0 0 6px; } .info .tip p:last-child { margin:0; }
@keyframes dv-pop { from { opacity:0; transform:translateY(-4px) scale(.98); } to { opacity:1; transform:none; } }
/* Файлы: плитки с превью */
.filters { display:flex; flex-wrap:wrap; gap:10px 12px; align-items:flex-end; }
.filters label { display:flex; flex-direction:column; gap:3px; font-size:13px; color:var(--mut); }
input[type=date], input[type=search] { padding:8px 10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); font:inherit; max-width:100%; }
.tiles { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:10px; margin-top:14px; }
.tile { position:relative; display:block; aspect-ratio:1; border-radius:14px; overflow:hidden; background:var(--soft); border:1px solid var(--line); color:inherit; text-decoration:none; transition:transform .15s, box-shadow .15s; }
.tile:hover { transform:translateY(-2px); box-shadow:0 0 22px -4px var(--acc); }
.tile .th { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; pointer-events:none; }
.tile .ext { position:absolute; inset:0; width:100%; height:100%; inset:0; display:grid; place-items:center; font-weight:700; color:var(--mut); font-size:15px; }
.tile .cap { position:absolute; left:0; right:0; bottom:0; padding:18px 8px 6px; font-size:12px; color:#fff; background:linear-gradient(transparent, rgba(0,0,0,.72)); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tile .cap small { display:block; opacity:.8; }
.pager { display:flex; justify-content:center; margin-top:16px; }
.acards { list-style:none; margin:12px 0 0; padding:0; display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:14px; }
.acard { border:1px solid var(--line); border-radius:14px; padding:14px 16px; background:var(--soft); }
.achead h3 { margin:0 0 6px; font-size:18px; line-height:1.25; word-break:break-word; }
.achead p { margin:6px 0 0; }
.achips { display:flex; flex-wrap:wrap; gap:6px; }
.apeople { border:0; padding:0; margin:12px 0 8px; display:flex; flex-wrap:wrap; gap:6px 14px; }
.apeople legend { padding:0; margin-bottom:6px; color:var(--mut); font-size:13px; }
.pick { display:flex; gap:6px; align-items:center; cursor:pointer; }
.pick input { width:18px; height:18px; }
.acact { display:flex; flex-wrap:wrap; gap:8px; }
.amore { margin-top:12px; }
.amore summary { cursor:pointer; color:var(--mut); font-size:14px; }
.amoreb { display:grid; gap:14px; margin-top:10px; }
.amoreb form { margin:0; } .amoreb p { margin:0 0 8px; font-size:14px; }
.afilter { display:flex; flex-wrap:wrap; gap:8px; margin:6px 0 0; }
.share-chips { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.chip form { display:inline; margin:0; } .chip button { padding:0 0 0 6px; border:0; background:transparent; color:var(--mut); font-size:14px; line-height:1; } .chip button:hover { color:var(--bad); }
@media (max-width:720px) { .panel { position:relative; } .info { position:static; } .info .tip { position:absolute; left:12px; right:12px; top:auto; width:auto; margin-top:8px; } }
.dest { display:grid; gap:10px; margin-top:10px; }
.setting b { display:inline; } .setting b + .info { margin-left:6px; }
`;

const layout = (title, body, head = '', foot = '') => `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="/style.css">${head}</head>
<body><main>${body}</main>${foot}</body></html>`;

const SCRIPT = '<script src="/viewer.js"></script>';
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

// «Инфо»: ненавязчивая кнопка с пояснением. text: один или несколько абзацев (строки/HTML из этого файла, не от людей).
export const info = (text, side = '') => `<details class="info${side ? ' ' + side : ''}"><summary aria-label="Инфо" title="Инфо">i</summary><div class="tip">${[].concat(text).map((t) => `<p>${t}</p>`).join('')}</div></details>`;

const TABS = [['users', '/', 'Люди'], ['files', '/files', 'Файлы'], ['dups', '/duplicates', 'Дубликаты'], ['sharing', '/sharing', 'Альбомы людям'], ['vault', '/vault', 'Сейф'], ['storage', '/storage', 'Хранилище'], ['media', '/media', 'Медиа'], ['faces', '/faces', 'Лица'], ['backup', '/backup', 'Копия']];
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
<div class="panel-head"><div><h2>Люди ${info(['Здесь заводятся люди облака, меняется место для каждого и закрывается доступ.','<b>Квота</b> — сколько места разрешено человеку; пусто — без лимита.','<b>Отключить</b> закрывает вход и сессии, файлы остаются. <b>Сбросить пароль</b> показывает новый пароль один раз: передайте его человеку.','<b>Удалить</b> просит ввести логин; галочка «с файлами» убирает и его записи о файлах.'])}</h2><p class="muted">Пароль показывается один раз при создании и сбросе.</p></div>
<details class="add"><summary class="btn primary">Добавить человека</summary>
<form method="post" action="/users">${csrfInput(csrf)}
<input type="text" name="login" placeholder="логин (a-z, 0-9, _)" pattern="[a-z0-9_]{2,32}" required aria-label="Логин">
<input type="text" name="displayName" placeholder="имя" maxlength="64" required aria-label="Имя">
<button class="primary" type="submit">Создать</button></form></details></div>
<ul class="people">${rows || '<li class="muted">Людей пока нет.</li>'}</ul>
</section>`);
}

export function storagePage({ stats, orphans, albums, deletedAlbums = [], requests, users, csrf, flash, loadError, dedupe }) {
  const logins = users.map((u) => u.login);
  const pick = (name) => `<select name="${name}" aria-label="Кому">${logins.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join('')}</select>`;
  const reqRows = requests.map((r) => `<tr><td><b>${esc(r.login)}</b> <span class="muted">${esc(r.displayName)}</span></td><td>${esc(formatSize(r.needBytes))}</td><td>${esc(formatSize(r.usedBytes))} из ${esc(formatQuota(r.quotaBytes))}</td><td>${esc(r.note || '—')}</td>
<td>${post(csrf, `/storage/requests/${encodeURIComponent(r.id)}/grant`, { login: r.login }, 'Задать квоту', '', '<input class="narrow" type="text" name="quota" placeholder="ГБ" aria-label="Новая квота, ГБ" required>')}
${post(csrf, `/storage/requests/${encodeURIComponent(r.id)}/resolve`, {}, 'Закрыть без изменений')}</td></tr>`).join('');
  const orphanRows = orphans.map((o) => `<tr><td>${esc(o.name)}</td><td>${esc(formatSize(o.size))}</td><td>${esc(o.createdAt.slice(0, 10))}</td>
<td>${o.note ? esc(o.note) : '<span class="muted">неизвестно (убрано до версии 0.10.0)</span>'}${o.orphanedAt ? `<br><span class="muted">${esc(o.orphanedAt.slice(0, 10))}</span>` : ''}</td>
<td>${post(csrf, `/storage/files/${encodeURIComponent(o.id)}/adopt`, {}, 'Отдать', '', pick('login'))}
${post(csrf, `/storage/files/${encodeURIComponent(o.id)}/purge`, {}, 'Стереть с диска', 'danger')}</td></tr>`).join('');
  const deletedRows = deletedAlbums.map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.owner)}</td><td>${a.count}</td><td>${esc((a.deletedAt ?? '').slice(0, 10))}</td>
<td>${post(csrf, `/storage/albums-deleted/${encodeURIComponent(a.id)}/restore`, {}, 'Вернуть хозяину')}
${post(csrf, `/storage/albums-deleted/${encodeURIComponent(a.id)}/purge`, {}, 'Стереть альбом', 'danger')}</td></tr>`).join('');
  const albumRows = albums.map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.owner)}</td><td>${a.count}</td><td>${a.sharedWith || '—'}</td>
<td>${post(csrf, `/storage/albums/${encodeURIComponent(a.id)}/transfer`, {}, 'Скопировать', '', pick('login'))}
${post(csrf, `/storage/albums/${encodeURIComponent(a.id)}/delete`, {}, 'Удалить', 'danger')}</td></tr>`).join('');
  return layout('DV Cloud: хранилище', `
${topBar('storage', csrf)}
${flashHtml(flash, loadError)}
${stats ? `<section class="panel"><div class="summary"><div><b>${stats.files}</b><span>записей людей</span></div><div><b>${stats.blobs}</b><span>файлов на диске</span></div><div><b>${esc(formatSize(stats.bytes))}</b><span>занято на диске</span></div><div><b>${stats.orphans}</b><span>без владельца</span></div><div><b>${stats.extraCopies}</b><span>лишних копий</span></div></div>${stats.yandex && stats.yandex.accounts > 0 ? `<p class="hint">Яндекс Диск подключён у людей: ${esc(stats.yandex.accounts)}${stats.yandex.expired > 0 ? ` (вход истёк: ${esc(stats.yandex.expired)})` : ''}. Файлов в списках: ${esc(stats.yandex.items)}, забрано: ${esc(stats.yandex.done)}.</p>` : ''}</section>` : ''}

<section class="panel"><h2>Просьбы о месте ${info('Люди могут попросить больше места прямо на сайте. «Задать квоту» ставит новый лимит в гигабайтах и закрывает просьбу, «Закрыть без изменений» просто убирает её из списка.')}</h2>
<table><thead><tr><th>Кто</th><th>Нужно</th><th>Сейчас</th><th>Комментарий</th><th>Действия</th></tr></thead>
<tbody>${reqRows || '<tr><td colspan="5" class="muted">Просьб нет.</td></tr>'}</tbody></table>

</section>
<section class="panel"><h2>Файлы без владельца ${info(['Остаются, когда человек убрал файл насовсем или аккаунт удалён. На диске лежат, пока вы их не отдадите или не сотрёте.','В колонке «Откуда» написано, кто убрал файл, из корзины или по очереди, и в каких альбомах он лежал. Если там названия альбомов, это, скорее всего, не мусор: подумайте, прежде чем стирать.','«Отдать» делает файл файлом выбранного человека (место идёт в его квоту). «Стереть с диска» необратимо.'])}</h2>
${stats && stats.orphans > 0 ? `<form class="bulk" method="post" action="/storage/orphans/purge">${csrfInput(csrf)}<input type="hidden" name="count" value="${esc(stats.orphans)}">
<p>Всего таких файлов: <b>${esc(stats.orphans)}</b>, они занимают <b>${esc(formatSize(stats.orphanBytes ?? 0))}</b>${orphans.length < stats.orphans ? ` (в таблице ниже только первые ${orphans.length})` : ''}. Стирание необратимо.</p>
<input type="text" name="word" placeholder="впишите: стереть" autocomplete="off" required aria-label="Подтверждение: впишите слово стереть"> <button class="danger" type="submit">Стереть с диска все ${esc(stats.orphans)}</button></form>` : ''}
<table><thead><tr><th>Файл</th><th>Размер</th><th>Дата</th><th>Откуда</th><th>Действия</th></tr></thead>
<tbody>${orphanRows || '<tr><td colspan="5" class="muted">Таких файлов нет.</td></tr>'}</tbody></table>

</section>
<section class="panel"><h2>Дубликаты</h2><p>Теперь это отдельная вкладка: <a href="/duplicates">Дубликаты</a>. Там список разбит на страницы, у каждого кадра зелёная или красная рамка.</p></section>
<section class="panel"><h2>Лишние копии на диске ${info(['Остались от старой версии, когда один файл мог лежать на диске несколько раз. Каждая копия сверяется по SHA-256 перед стиранием.','«Только проверить» ничего не меняет и показывает, сколько места можно освободить.'])}</h2>
${dedupe ? (dedupe.checked === 0
    ? '<div class="msg ok">Лишних копий не найдено: на диске каждый файл лежит один раз. Так и должно быть, делать ничего не нужно.</div>'
    : `<div class="msg ok">Найдено лишних копий: ${dedupe.checked}${dedupe.removed ? `, удалено: ${dedupe.removed}` : ''}, освобождено: ${esc(formatSize(dedupe.freedBytes))}${dedupe.mismatched.length ? `, не совпали по содержимому и оставлены: ${dedupe.mismatched.length}` : ''}</div>`) : ''}
<p>${post(csrf, '/storage/dedupe', { apply: '0' }, 'Только проверить')} ${post(csrf, '/storage/dedupe', { apply: '1' }, 'Удалить лишние копии', 'danger')}</p>

</section>
<section class="panel"><h2>Удалённые альбомы ${info(['Человек удалил альбом у себя, но облако его не стёрло, а убрало сюда. Фото из такого альбома по-прежнему лежат в библиотеке человека, ничего не потеряно.','«Вернуть хозяину» возвращает альбом как был. «Стереть альбом» убирает только сам альбом, без фото.','Если файлы потом окажутся в списке «без владельца», рядом будет написано, из какого альбома они.'])}</h2>
<table><thead><tr><th>Альбом</th><th>Хозяин</th><th>Файлов</th><th>Удалён</th><th>Действия</th></tr></thead>
<tbody>${deletedRows || '<tr><td colspan="5" class="muted">Удалённых альбомов нет.</td></tr>'}</tbody></table>
</section>
<section class="panel"><h2>Альбомы ${info(['«Скопировать» создаёт такой же альбом у выбранного человека со ссылками на те же файлы; место на диске не тратится, но идёт в его квоту.','«Удалить» убирает только сам альбом (и общий доступ к нему), файлы людей остаются.','Показать альбом другим без копирования можно на вкладке «Альбомы людям».'])}</h2>
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
  return `<section class="panel"><div class="panel-head"><div><h2>Даты у загруженных файлов ${info(['Облако берёт дату съёмки из метаданных файла (EXIF у фото, время создания у видео), если их нет, из имени файла (например «2020-05-25 18-55-28.jpg»), и только потом из даты изменения.','У файлов, загруженных раньше, дата могла быть взята из даты изменения. «Проверить» показывает, сколько дат изменится, и ничего не меняет.'])}</h2></div>
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
  return `<section class="panel"><div class="panel-head"><div><h2>Поиск по смыслу ${info('Показывает, работает ли служба ML и сколько файлов уже «просмотрено». «Повторить неудачные» пробует ещё раз то, что не прочиталось; «Пересчитать всё» стирает все векторы, и они считаются заново несколько часов.')}</h2><p class="muted">Служба: ${mlState(x)}.</p></div>
<div>${x.failed ? clear('index-failed', 'Повторить неудачные', '', 'Файлы, которые не удалось прочитать, попробуются снова') : ''}${clear('index', 'Пересчитать всё', 'danger', 'Стереть все векторы: они посчитаются заново, это займёт часы')}</div></div>
<p>Готово ${x.ready} из ${x.total}${x.failed ? `, не удалось прочитать: ${x.failed}` : ''}${x.pending ? `, в очереди: ${x.pending}` : ''}. Векторы занимают ${esc(formatSize(x.sizeBytes))} в базе.</p>
<progress max="${Math.max(x.total, 1)}" value="${x.ready + x.failed}" aria-label="Ход построения векторов"></progress>
<p class="muted">${s.searchEnabled ? 'Поиск включён: векторы считаются в фоне, когда нет загрузок, и пока вы не выключите.' : 'Поиск выключен: ничего не считается, строка поиска на сайте скрыта.'}</p></section>`;
};

// Лица и питомцы: готовность моделей, ход просмотра, находки, полная очистка (со словом-подтверждением).
// Ход и итог долгой операции над группами людей (подсчёт или пересборка). Пока идёт, страница сама обновляется.
const simText = (n) => (n / 100).toFixed(2).replace('.', ',');
const jobBlock = (j) => {
  if (!j) return '';
  const name = j.kind === 'hint' ? 'Подсчёт групп' : 'Пересборка групп';
  if (j.state === 'running') {
    return `<div class="msg" role="status"><b>${name}: идёт.</b> ${esc(j.text)}. Прошло ${j.elapsedSec} с.
<progress max="${Math.max(j.steps, 1)}" value="${j.step}" aria-label="Ход: ${name}"></progress>
<span class="muted">Страница обновляется сама каждые 3 секунды. Её можно закрыть: работа идёт на сервере.</span></div>`;
  }
  if (j.state === 'error') return `<div class="msg error" role="alert"><b>${name}: не получилось.</b> ${esc(j.error ?? 'Неизвестная ошибка')}. Попробуйте ещё раз; если повторится, смотрите журнал сервера.</div>`;
  if (j.kind === 'rebuild' && j.rebuild) {
    return `<div class="msg ok"><b>Пересборка групп готова</b> (заняла ${j.elapsedSec} с). Безымянных групп стёрто: ${j.rebuild.removed}, собрано заново: ${j.rebuild.created}. Названные, скрытые и правленные вручную группы остались. Всего групп людей теперь: ${j.rebuild.kept}.</div>`;
  }
  if (j.kind === 'hint' && j.hint) {
    return `<div class="msg ok"><b>Подсчёт готов</b> (занял ${j.elapsedSec} с). Сколько групп людей получилось бы при каждой строгости (ничего не изменилось):
<ul>${j.hint.map((x) => `<li>при ${simText(x.sim)}: ${x.groups} групп, без группы останется ${x.ungrouped} лиц</li>`).join('')}</ul></div>`;
  }
  return '';
};

const peoplePanel = (p, s, csrf, up, job) => {
  if (!p) return '';
  const busy = job?.state === 'running';
  const row = (label, x) => {
    const state = !x.enabled ? 'выключено' : !up ? 'ждёт службу ML' : !x.modelFiles ? 'нет файлов модели' : x.pending ? 'идёт просмотр' : 'всё просмотрено';
    return `<p><b>${label}:</b> ${state}. Готово ${x.done} из ${x.total}${x.failed ? `, не удалось прочитать: ${x.failed}` : ''}${x.pending ? `, в очереди: ${x.pending}` : ''}.</p>
<progress max="${Math.max(x.total, 1)}" value="${x.done + x.failed}" aria-label="Ход просмотра: ${label}"></progress>`;
  };
  return `<section class="panel"><div class="panel-head"><div><h2>Люди и питомцы ${info('Ход распознавания лиц и питомцев, пересборка групп и полная очистка данных. Фото при этом не затрагиваются.')}</h2><p class="muted">Найдено лиц: ${p.detections.faces}, питомцев: ${p.detections.pets}. Групп: ${p.groups}, из них названо людьми: ${p.named}.</p></div></div>
${row('Лица', p.faces)}
${row('Питомцы', p.pets)}
${jobBlock(job)}
<div class="setting"><div><b>Пересобрать группы</b> ${info(`Стирает только безымянные группы людей, которые сделала сама программа, и собирает лица заново по текущей строгости (сохраните её выше). <b>Остаются как есть:</b> группы с именем, скрытые группы и группы, где вы что-то правили вручную; к названным группам при этом присоединятся и подходящие лица из стёртых. Объединённая вами группа без имени считается безымянной и будет пересобрана: если хотите сохранить её, назовите. Фото и имена не страдают. Работа идёт в фоне: ход и итог видны ниже в этой панели, страница обновляется сама.`)}</div>
<span><form method="post" action="/media/people/hint" class="inline">${csrfInput(csrf)}<button type="submit"${busy ? ' disabled' : ''} title="Только посчитать, ничего не меняется">Показать, сколько групп получится</button></form> <form method="post" action="/media/people/rebuild" class="inline">${csrfInput(csrf)}<button class="danger" type="submit"${busy ? ' disabled' : ''}>Пересобрать группы</button></form></span></div>
<form method="post" action="/media/clear">${csrfInput(csrf)}<input type="hidden" name="what" value="people">
<p class="muted">Стереть все находки, группы и имена людей и питомцев у всех. Фото не затрагиваются. Если распознавание включено, просмотр начнётся заново, а названия придётся давать снова.</p>
<p><input type="text" name="word" placeholder="впишите: стереть" autocomplete="off" aria-label="Подтверждение: слово стереть"> <button class="danger" type="submit">Стереть данные лиц</button></p></form></section>`;
};

export function mediaPage({ media, dates, csrf, flash, loadError }) {
  const s = media?.settings;
  const clear = (what, label, hint) =>
    `<form method="post" action="/media/clear">${csrfInput(csrf)}<input type="hidden" name="what" value="${what}"><button class="danger" type="submit" title="${esc(hint)}">${label}</button></form>`;
  const stats = media
    ? `<section class="panel"><div class="panel-head"><div><h2>Что лежит на диске ${info('Это производные файлы: миниатюры, превью и копии видео. Оригиналы они не затрагивают, всё можно очистить, и оно построится заново.')}</h2></div></div>
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
    ? `<form method="post" action="/media/settings" autocomplete="off">${csrfInput(csrf)}
<section class="panel"><h2>Фото</h2>
<div class="setting"><div><b>Превью для просмотра</b> ${info(`Облегчённая копия, которую сайт открывает вместо оригинала. Выключено: сайт открывает оригинал, скачивание всегда отдаёт оригинал.`)}</div>${sw('previewEnabled', s.previewEnabled, 'Использовать')}</div>
<div class="setting"><div><b>Размер превью</b> ${info(`Длинная сторона в пикселях, от 600 до 4000. Для телефона и ноутбука хватает 1600–2000.`)}</div><input class="narrow" type="number" name="previewMaxSide" min="600" max="4000" step="100" value="${s.previewMaxSide}" aria-label="Размер превью, px"></div>
<div class="setting"><div><b>Качество превью</b> ${info(`От 30 до 95. Выше число: чище картинка и больше файл. Обычно 75–85.`)}</div><input class="narrow" type="number" name="previewQuality" min="30" max="95" step="1" value="${s.previewQuality}" aria-label="Качество превью"></div>
</section>
<section class="panel"><h2>Видео</h2>
<div class="setting"><div><b>Копии для просмотра</b> ${info(`Облако в фоне делает из видео уменьшенную копию (H.264), по одному ролику, с низким приоритетом и только когда нет загрузок. Плеер на сайте берёт копию, а скачивание отдаёт оригинал. Нагружает процессор сервера, поэтому по умолчанию выключено.`)}</div>${sw('videoEnabled', s.videoEnabled, 'Делать и использовать')}</div>
<div class="setting"><div><b>Размер кадра копии</b> ${info(`Высота по вертикали. Кадр не увеличивается: ролик меньше выбранного остаётся как есть по размеру.`)}</div><select name="videoHeight" aria-label="Высота кадра">${[480, 720, 1080].map((h) => `<option value="${h}"${h === s.videoHeight ? ' selected' : ''}>${h}p</option>`).join('')}</select></div>
<div class="setting"><div><b>Качество копии</b> ${info(`Выше качество: лучше картинка, больше файл и дольше работа. Если копия получается не меньше оригинала, она не сохраняется.`)}</div><select name="videoCrf" aria-label="Качество видео">${crfOptions.map(([v, l]) => `<option value="${v}"${v === s.videoCrf ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
</section>
<section class="panel"><h2>Поиск по смыслу</h2>
<div class="setting"><div><b>Искать фото и видео по описанию</b> ${info(`Облако в фоне «просматривает» каждое фото (для видео один кадр) нейросетью и запоминает его смысл, поэтому на сайте можно искать словами: «собака на пляже», «скриншот переписки». Работает по-русски. Фото не покидают ваш сервер. Нагружает процессор часами (разово), поэтому по умолчанию выключено.`)}</div>${sw('searchEnabled', s.searchEnabled, 'Включить поиск')}</div>
<div class="setting"><div><b>Строгость выдачи</b> ${info(`В результатах остаются файлы, которые подходят не хуже этого процента от лучшего совпадения, от 50 до 95. Больше число: короче и точнее выдача. Меньше: больше находок, но и больше лишнего.`)}</div><input class="narrow" type="number" name="searchCutoff" min="50" max="95" step="1" value="${s.searchCutoff}" aria-label="Строгость выдачи, проценты"></div>
</section>
<section class="panel"><h2>Люди и питомцы</h2>
<div class="setting"><div><b>Узнавать лица на фото</b> ${info(`Облако в фоне находит лица нейросетью и собирает их в группы «один человек»; каждый член семьи называет своих людей сам, чужих названий не видит, а на сайте можно искать «фото с Валей». Лица считаются в вашем облаке и никуда не отправляются. Это биометрические данные: включайте, только если все, кто пользуется облаком, согласны. Нагружает процессор часами (разово), поэтому по умолчанию выключено.`)}</div>${sw('facesEnabled', s.facesEnabled, 'Включить лица')}</div>
<div class="setting"><div><b>Строгость объединения лиц</b> ${info(`От 30 до 55 (процентов сходства), по умолчанию 45. Меньше число: лица объединяются охотнее, групп меньше и они крупнее, но среди них чаще попадаются чужие люди. Больше число: группы чище, но один человек распадается на много групп. Для семьи обычно подходит 38–42. Новое значение действует на лица, которые ещё не разобраны; уже собранные группы сами не меняются: чтобы применить его к ним, нажмите «Пересобрать группы» ниже. Сначала сохраните настройки.`)}</div><input class="narrow" type="number" name="facesSim" min="30" max="55" step="1" value="${s.facesSim}" aria-label="Строгость объединения лиц, проценты"></div>
<div class="setting"><div><b>Узнавать питомцев</b> ${info(`Так же находит кошек и собак. Узнавание по снимку питомца заметно грубее, чем для людей: группы можно объединять и править вручную.`)}</div>${sw('petsEnabled', s.petsEnabled, 'Включить питомцев')}</div>
</section>
<section class="panel"><h2>Даты съёмки</h2>
<div class="setting"><div><b>Часовой пояс</b> ${info(`В нём записано время в метаданных и в именах файлов (там нет пояса). Для семьи в Москве: Europe/Moscow. Применяется к новым загрузкам и к пересчёту ниже.`)}</div><span><input type="text" name="timezone" list="tz" value="${esc(s.timezone)}" maxlength="64" aria-label="Часовой пояс"><datalist id="tz">${TIMEZONES.map((z) => `<option value="${z}">`).join('')}</datalist></span></div>
</section>
<section class="panel"><div class="panel-head"><p class="muted">Смена размера или качества стирает готовые превью и копии: они построятся заново с новыми настройками.</p><button class="primary" type="submit">Сохранить настройки</button></div></section>
</form>`
    : '';
  return layout('DV Cloud: медиа', `
${topBar('media', csrf)}
${flashHtml(flash, loadError)}
${stats}
${media ? searchPanel(media.search, s, csrf) : ''}
${media ? peoplePanel(media.people, s, csrf, media.search.up, media.peopleJob) : ''}
${form}
${media ? datesPanel(dates, csrf) : ''}`, media?.peopleJob?.state === 'running' ? '<meta http-equiv="refresh" content="3">' : '');
}


// ── Файлы всех людей: плитки с превью, фильтры по человеку, датам, имени и альбому (только просмотр, без журнала) ──
const extOf = (name) => (String(name).includes('.') ? String(name).split('.').pop().slice(0, 5).toUpperCase() : 'ФАЙЛ');

export function filesPage({ data, users, albums, filter, csrf, flash, loadError }) {
  const f = filter;
  const opt = (v, label, cur) => `<option value="${esc(v)}"${String(cur) === String(v) ? ' selected' : ''}>${esc(label)}</option>`;
  const keep = (extra = {}) => new URLSearchParams(Object.entries({ login: f.login, from: f.from, to: f.to, q: f.q, album: f.album, ...extra }).filter(([, v]) => v)).toString();
  const tiles = (data?.files ?? []).map((x) => `<a class="tile" href="/files/${esc(x.id)}${keep() ? '?' + esc(keep()) : ''}" title="${esc(x.name)}">
<object class="th" data="/files/${esc(x.id)}/thumb" type="image/webp" aria-label="${esc(x.name)}"><span class="ext">${esc(extOf(x.name))}</span></object>
<span class="cap">${esc(x.name)}<small>${esc(x.owner)} · ${esc(x.takenAt.slice(0, 10))} · ${esc(formatSize(x.size))}</small></span></a>`).join('');
  return layout('DV Cloud: файлы', `
${topBar('files', csrf)}
${flashHtml(flash, loadError)}
<section class="panel"><div class="panel-head"><div><h2>Файлы всех людей ${info(['Здесь видны все фото и видео, которые лежат в облаке, от новых к старым по дате съёмки. Можно отобрать по человеку, по датам, по части имени или по альбому.','Нажмите на плитку: откроется просмотр файла с информацией, соседними файлами, скачиванием и ссылками на альбомы. Видео играет встроенным плеером браузера.','Серая плитка с буквами вместо картинки: миниатюра ещё не построена (она строится, когда человек открывает свою ленту). Сам файл всё равно открывается.','Список только для просмотра: ничего не удаляется и не меняется. Корзины людей сюда не попадают.'])}</h2>
<p class="muted">Только просмотр. Найдено: <b>${data ? esc(data.total) : 0}</b></p></div></div>
<form class="filters" method="get" action="/files">
<label>Человек<select name="login"><option value="">все</option>${users.map((u) => opt(u.login, u.displayName ? `${u.displayName} (${u.login})` : u.login, f.login)).join('')}</select></label>
<label>С даты<input type="date" name="from" value="${esc(f.from ?? '')}"></label>
<label>По дату<input type="date" name="to" value="${esc(f.to ?? '')}"></label>
<label>Часть имени<input type="search" name="q" value="${esc(f.q ?? '')}" maxlength="100" placeholder="например IMG_"></label>
<label>Альбом<select name="album"><option value="">любой</option>${albums.map((a) => opt(a.id, `${a.name} — ${a.owner}`, f.album)).join('')}</select></label>
<button class="primary" type="submit">Показать</button> <a class="btn" href="/files">Сбросить фильтр</a></form>
<div class="tiles">${tiles || '<p class="muted">Ничего не найдено. Попробуйте убрать часть условий.</p>'}</div>
${data?.next ? `<div class="pager"><a class="btn" href="/files?${esc(keep({ before: data.next }))}">Показать ещё</a></div>` : ''}
</section>`);
}

// ── Дубликаты: отдельная вкладка, страницами ──
// Каждый кадр в рамке: зелёная = оставить, красная = убрать. Рамка переключается нажатием на полосу под картинкой
// (скрытый флажок + подпись, без скриптов). Удержание левой кнопки на картинке приближает её (с viewer.js; без него работает :active).
export function dupPage({ report: d, page, per, csrf, flash, loadError }) {
  const pageHref = (n) => `/duplicates?page=${n}&per=${per}`;
  const pages = d ? Math.max(1, Math.ceil(d.totalGroups / per)) : 1;
  const pager = (d && d.totalGroups > per) ? `<div class="pager top"><a class="btn${page <= 1 ? ' off' : ''}" href="${pageHref(Math.max(1, page - 1))}"${page <= 1 ? ' aria-disabled="true" tabindex="-1"' : ''}>← Назад</a><span class="cur">Страница ${page} из ${pages}</span><a class="btn${page >= pages ? ' off' : ''}" href="${pageHref(Math.min(pages, page + 1))}"${page >= pages ? ' aria-disabled="true" tabindex="-1"' : ''}>Далее →</a><span class="muted">На странице: <a href="/duplicates?page=1&per=50">50</a> · <a href="/duplicates?page=1&per=100">100</a></span></div>` : (d && d.totalGroups ? `<div class="pager top"><span class="muted">На странице: <a href="/duplicates?page=1&per=50">50</a> · <a href="/duplicates?page=1&per=100">100</a></span></div>` : '');
  let body;
  if (!d) {
    body = '<p class="muted">Данные о дубликатах не получены.</p>';
  } else {
    const head = d.computedAt
      ? `<p>Последняя проверка: <b>${esc(d.computedAt.slice(0, 16).replace('T', ' '))}</b> (UTC)${d.scanning ? ', идёт новая' : ''}. Групп дубликатов: <b>${d.totalGroups}</b>${d.totalGroups ? `, можно освободить <b>${esc(formatSize(d.reclaimBytes))}</b>` : ''}.</p>`
      : `<p class="muted">Первая проверка ещё не проходила${d.scanning ? ', она идёт сейчас' : ': запустится сама через минуту после старта облака'}.</p>`;
    if (!d.groups.length) {
      body = `${head}${d.computedAt ? (d.totalGroups ? `<p class="muted">На этой странице групп нет. <a href="${pageHref(1)}">К первой странице</a></p>` : '<p class="muted">Дубликатов нет: у каждого снимка одна копия.</p>') : ''}`;
    } else {
      const groups = d.groups.map((g) => {
        const cards = g.blobs.map((b) => {
          const id = `k-${esc(g.id)}-${esc(b.blobId)}`;
          const fid = encodeURIComponent(b.fileId);
          return `<li class="dup"><input class="dupchk" type="checkbox" id="${id}" name="keep" value="${esc(g.id)}:${esc(b.blobId)}"${b.keep ? ' checked' : ''}>
<button type="button" class="zoomhold" aria-label="Приблизить (удерживайте)" title="Удерживайте левую кнопку, чтобы приблизить"><img src="/files/${fid}/thumb" alt="" width="140" height="140" loading="lazy"></button><div class="zoombox" aria-hidden="true"><figure><img src="/files/${fid}/zoom" alt="" loading="lazy"><figcaption>${b.width}×${b.height}, ${esc(formatSize(b.size))}</figcaption></figure></div>
<label class="dupstrip" for="${id}"><span class="y">Оставить</span><span class="n">Убрать</span></label>
<div class="dupmeta">${b.width}×${b.height}, ${esc(formatSize(b.size))}<br><span class="muted">${b.owners.map((o) => esc(o.login) + (o.files > 1 ? ` ×${o.files}` : '')).join(', ') || '—'}</span></div></li>`;
        }).join('');
        return `<div class="dupgroup"><input type="hidden" name="g" value="${esc(g.id)}"><ul class="dups">${cards}</ul>
<p><button class="danger" type="submit" name="only" value="${esc(g.id)}">Применить к этой группе: освободить ${esc(formatSize(g.reclaimBytes))}</button></p></div>`;
      }).join('');
      const bk = d.bulk ?? { running: false, total: 0, done: 0, failed: 0, bytes: 0, finishedAt: null };
      const last = bk.finishedAt ? `<p class="muted">Прошлое удаление: обработано ${bk.done} из ${bk.total}${bk.failed ? `, пропущено ${bk.failed}` : ''}, освобождено ${esc(formatSize(bk.bytes))}.</p>` : '';
      const bar = bk.running
        ? `<div class="dupbar"><p><b>Идёт удаление дубликатов:</b> ${bk.done} из ${bk.total} групп, освобождено ${esc(formatSize(bk.bytes))}${bk.failed ? `, пропущено ${bk.failed}` : ''}. Страница обновляется сама.</p></div>`
        : `<div class="dupbar">${d.mergeable > 0
          ? `<details class="dupconfirm"><summary class="danger">Применить к этой странице: ${d.groups.length} групп</summary>
<p>В каждой группе останутся кадры с зелёной рамкой, остальные (красные) будут стёрты с диска. Группа, где все рамки красные, пропускается. Это необратимо.</p>
<button class="danger" type="submit">Да, применить</button></details>`
          : ''}${last}</div>`;
      // Итог последнего применения сверху страницы (а не только внизу списка): сколько обработано и почему часть групп пропущена.
      const lastRun = (() => {
        const k = d.bulk;
        if (!k) return '';
        if (k.running) return `<div class="msg ok"><b>Идёт применение:</b> ${k.done} из ${k.total} групп, освобождено ${esc(formatSize(k.bytes))}. Страница обновляется сама.</div>`;
        if (!k.finishedAt) return '';
        const why = (k.problems ?? []).map((p) => `<li>Группа ${esc(p.group)}: ${esc(p.text)}</li>`).join('');
        return `<div class="msg ${k.failed ? 'error' : 'ok'}"><b>Последнее применение:</b> групп обработано ${k.done} из ${k.total}, освобождено ${esc(formatSize(k.bytes))}${k.failed ? `, не получилось: ${k.failed}` : ''}.${why ? `<ul>${why}</ul>` : ''}</div>`;
      })();
      body = `${head}${lastRun}<div class="legend"><span class="g"><i></i>зелёная рамка: оставить</span><span class="r"><i></i>красная рамка: убрать</span><span class="muted">Нажмите на полосу под картинкой, чтобы сменить. Удерживайте левую кнопку на картинке, чтобы рассмотреть.</span></div>
<form method="post" action="/storage/duplicates/apply">${csrfInput(csrf)}<input type="hidden" name="page" value="${page}"><input type="hidden" name="per" value="${per}">${pager}${groups}${bar}${pager}</form>`;
    }
  }
  return layout('DV Cloud: дубликаты', `
${topBar('dups', csrf)}
${flashHtml(flash, loadError)}
<section class="panel"><div class="panel-head"><div><h2>Дубликаты по всему хранилищу ${info(['Облако само ищет в фоне снимки, которые лежат в нескольких качествах: оригинал и уменьшенная копия из мессенджера. Сравниваются файлы на диске у всех людей вместе.','Рамка: зелёная оставить, красная убрать. Лучший кадр (больше пикселей) отмечен зелёным заранее; можно оставить два или три.','Оставленные вместе кадры больше не предлагаются как дубликаты. Лишние файлы стираются с диска, записи людей переключаются на оставленный; названия, даты съёмки и альбомы сохраняются. Это необратимо.','«Применить к этой странице» обрабатывает группы, которые видны сейчас. Потом откроется следующая страница или те же номера, но уже следующие группы.','Серии похожих кадров здесь не ищутся: с ними работают люди у себя на сайте.'])}</h2></div>
<form method="post" action="/storage/duplicates/scan">${csrfInput(csrf)}<input type="hidden" name="page" value="${page}"><input type="hidden" name="per" value="${per}"><button type="submit">Проверить сейчас</button></form></div>
${body}
</section>`, (d?.bulk?.running || d?.scanning) ? '<meta http-equiv="refresh" content="3">' : '', SCRIPT);
}

// ── Лица: общие группы людей и питомцев всего хранилища ──
// Обычные пользователи могут только подписывать лица и говорить «не он»; объединять, распускать и переименовывать названные
// группы можно только здесь. Карточки крупные, как на вкладке «Дубликаты»; без скриптов, всё обычными формами.
const FACE_PER = 24;
export function facesPage({ data: d, q, csrf, flash, loadError }) {
  const href = (extra = {}) => `/faces?${new URLSearchParams(Object.entries({ kind: q.kind, q: q.q, unnamed: q.unnamed, ...extra }).filter(([, v]) => v)).toString()}`;
  const pages = d ? Math.max(1, Math.ceil(d.total / FACE_PER)) : 1;
  const pager = d && d.total > FACE_PER
    ? `<div class="pager top"><a class="btn${q.page <= 1 ? ' off' : ''}" href="${href({ page: Math.max(1, q.page - 1) })}"${q.page <= 1 ? ' aria-disabled="true" tabindex="-1"' : ''}>← Назад</a><span class="cur">Страница ${q.page} из ${pages}</span><a class="btn${q.page >= pages ? ' off' : ''}" href="${href({ page: Math.min(pages, q.page + 1) })}"${q.page >= pages ? ' aria-disabled="true" tabindex="-1"' : ''}>Далее →</a></div>`
    : '';
  const opt = (v, label) => `<option value="${v}"${q.kind === v ? ' selected' : ''}>${label}</option>`;
  const filter = `<form class="filter" method="get" action="/faces"><label>Кто<select name="kind">${opt('', 'люди и питомцы')}${opt('person', 'люди')}${opt('pet', 'питомцы')}</select></label>
<label>Имя<input type="text" name="q" value="${esc(q.q)}" maxlength="60" placeholder="часть имени"></label>
<label class="chk"><input type="checkbox" name="unnamed" value="1"${q.unnamed ? ' checked' : ''}> только без имени</label>
<button class="primary" type="submit">Показать</button> <a class="btn" href="/faces">Сбросить</a></form>`;
  let body;
  if (!d) body = '<p class="muted">Данные не получены.</p>';
  else if (!d.enabled.faces && !d.enabled.pets) body = '<p class="muted">Распознавание лиц и питомцев выключено на вкладке «Медиа». Включите его, и здесь появятся группы.</p>';
  else if (!d.groups.length) body = '<p class="muted">Групп по этому условию нет.</p>';
  else {
    const cards = d.groups.map((g) => `<li class="face">
<a class="facepic" href="/faces/${esc(g.id)}"><img src="/faces/crop/${esc(g.cover)}" alt="" width="160" height="160" loading="lazy"></a>
<div class="facemeta"><b>${g.name ? esc(g.name) : '<span class="muted">без имени</span>'}</b>${g.kind === 'pet' ? ' <span class="muted">питомец</span>' : ''}<br><span class="muted">файлов: ${g.count}${g.owners.length ? `, у: ${g.owners.map(esc).join(', ')}` : ''}${g.owners.length > 1 ? ' (общая)' : ''}${g.hiddenBy ? `, скрыта у ${g.hiddenBy}` : ''}</span></div>
<label class="facepick"><input type="radio" name="into" value="${esc(g.id)}"> Остаётся</label>
<label class="facepick"><input type="checkbox" name="from" value="${esc(g.id)}"> Влить в оставшуюся</label>
<a class="btn" href="/faces/${esc(g.id)}">Открыть</a></li>`).join('');
    body = `<form method="post" action="/faces/merge"><input type="hidden" name="back" value="${esc(href({ page: q.page }))}">${csrfInput(csrf)}${pager}<ul class="faces">${cards}</ul>
<div class="dupbar"><p class="muted">Отметьте одну группу «Остаётся» и одну или несколько «Влить в оставшуюся». Имя останется у оставшейся (если у неё нет имени, возьмётся имя первой названной из вливаемых). Это нельзя отменить.</p>
<button class="danger" type="submit">Объединить отмеченные</button></div>${pager}</form>`;
  }
  return layout('DV Cloud: лица', `
${topBar('faces', csrf)}
${flashHtml(flash, loadError)}
<section class="panel"><div class="panel-head"><div><h2>Лица и питомцы ${info(['Группы общие для всего хранилища: человек, названный один раз, называется так у всех. У каждого в списке только те, кто есть на его фото, а сами файлы остаются доступны только владельцам.','Обычный пользователь может подписать безымянную группу, сказать «это он», «не он», убрать фото из группы и скрыть группу у себя. Объединять, распускать и переименовывать названные и общие группы может только администратор, то есть вы здесь.','Если у группы фото нескольких людей, она общая (в карточке видно, у кого).'])}</h2></div></div>
${filter}
${d ? `<p class="muted">Всего групп: <b>${d.total}</b></p>` : ''}
${body}
</section>`);
}

// Одна группа: крупные лица, имя, «убрать из группы», распустить.
export function facePage({ data: d, offset, csrf, flash, loadError }) {
  const g = d.group;
  const per = 48;
  const prev = offset - per >= 0 ? `/faces/${esc(g.id)}?offset=${offset - per}` : null;
  const next = offset + per < d.total ? `/faces/${esc(g.id)}?offset=${offset + per}` : null;
  const cards = d.faces.map((f) => `<li class="face">
<a class="facepic" href="/files/${esc(f.fileId)}"><img src="/faces/crop/${esc(f.id)}" alt="" width="160" height="160" loading="lazy"></a>
<div class="facemeta"><span class="muted">${esc(f.owner)}${f.source === 'manual' ? ', подписано человеком' : ', автоматически'}</span></div>
<form method="post" action="/faces/${esc(g.id)}/remove-face">${csrfInput(csrf)}<input type="hidden" name="det" value="${esc(f.id)}"><input type="hidden" name="offset" value="${offset}"><button type="submit">Убрать из группы</button></form></li>`).join('');
  return layout('DV Cloud: лица', `
${topBar('faces', csrf)}
${flashHtml(flash, loadError)}
<section class="panel"><div class="panel-head"><div><h2>${g.name ? esc(g.name) : 'Группа без имени'} ${g.kind === 'pet' ? '(питомец)' : ''}</h2></div><a class="btn" href="/faces">← Ко всем группам</a></div>
<p class="muted">Файлов: ${g.count}${g.owners.length ? `, у: ${g.owners.map(esc).join(', ')}` : ''}${g.owners.length > 1 ? ' (общая группа)' : ''}. Лиц в группе: ${d.total}.</p>
<form method="post" action="/faces/${esc(g.id)}/rename" class="filter">${csrfInput(csrf)}<label>Имя<input type="text" name="name" value="${esc(g.name ?? '')}" maxlength="60" placeholder="Как зовут?"></label>
<button class="primary" type="submit">Сохранить имя</button><button type="submit" name="clear" value="1">Стереть имя</button></form>
<ul class="faces">${cards || '<li class="muted">В группе нет лиц.</li>'}</ul>
<div class="pager">${prev ? `<a class="btn" href="${prev}">← Назад</a>` : ''}${next ? `<a class="btn" href="${next}">Далее →</a>` : ''}</div>
<details class="dupconfirm"><summary class="danger">Распустить группу</summary>
<p>Группа и имя исчезнут, сами фото останутся. Лица могут собраться в новую безымянную группу позже.</p>
<form method="post" action="/faces/${esc(g.id)}/dissolve">${csrfInput(csrf)}<button class="danger" type="submit">Да, распустить</button></form></details>
</section>`);
}

// ── Просмотр одного файла ──
const WEB_IMAGE = /^image\/(jpeg|png|webp|gif|avif)$/i;
export function filePage({ info: x, filter = {}, csrf, flash, loadError }) {
  const f = x.file;
  const qs = (extra = {}) => new URLSearchParams(Object.entries({ login: filter.login, from: filter.from, to: filter.to, q: filter.q, album: filter.album, ...extra }).filter(([, v]) => v)).toString();
  const withQ = (id) => `/files/${encodeURIComponent(id)}${qs() ? '?' + qs() : ''}`;
  const id = encodeURIComponent(f.id);
  const isVideo = /^video\//i.test(f.mime);
  const shown = isVideo
    ? `<video controls playsinline preload="metadata" poster="/files/${id}/thumb" src="/files/${id}/view"></video>`
    : WEB_IMAGE.test(f.mime) ? `<img src="/files/${id}/view" alt="${esc(f.name)}">` : `<img src="/files/${id}/zoom" alt="${esc(f.name)}">`;
  const conv = !isVideo && !WEB_IMAGE.test(f.mime) ? '<p class="muted">Формат браузер не показывает сам (например HEIC): показан просмотр, сам файл можно скачать.</p>' : '';
  const nav = (rel, to, label) => to ? `<a class="btn" rel="${rel}" href="${esc(withQ(to))}">${label}</a>` : `<span class="btn off">${label}</span>`;
  const albums = x.albums.length
    ? x.albums.map((a) => `<a class="chip" href="/sharing?owner=${encodeURIComponent(a.owner)}&q=${encodeURIComponent(a.name)}" title="Раздача, передача и сейф этого альбома">${esc(a.name)}</a>`).join(' ')
    : '<span class="muted">ни в одном</span>';
  const day = f.takenAt.slice(0, 10);
  return layout(`DV Cloud: ${f.name}`, `
${topBar('files', csrf)}
${flashHtml(flash, loadError)}
<div class="fnav"><a class="btn" data-back href="/files${qs() ? '?' + esc(qs()) : ''}">← К списку</a>${nav('prev', x.prev, '← Новее')}${nav('next', x.next, 'Старее →')}<span class="sp"></span><span class="muted">Стрелки ← → листают, Esc возвращает к списку</span></div>
<div class="fview"><div><div class="stage">${shown}</div>${conv}</div>
<aside class="panel"><h2>${esc(f.name)}</h2>
<dl class="facts"><dt>Владелец</dt><dd><b>${esc(f.owner)}</b></dd>
<dt>Снято</dt><dd>${esc(f.takenAt.slice(0, 16).replace('T', ' '))} (UTC)</dd>
<dt>Загружено</dt><dd>${esc(f.createdAt.slice(0, 16).replace('T', ' '))} (UTC)</dd>
<dt>Размер</dt><dd>${esc(formatSize(f.size))}${f.width && f.height ? `, ${f.width}×${f.height}` : ''}</dd>
<dt>Тип</dt><dd>${esc(f.mime)}</dd>
<dt>Альбомы</dt><dd>${albums}</dd>
<dt>Тот же файл у</dt><dd>${x.copies.length ? x.copies.map(esc).join(', ') : '<span class="muted">больше ни у кого</span>'}</dd>
<dt>SHA-256</dt><dd><code>${esc(f.sha256)}</code></dd></dl>
<div class="factions"><a class="btn primary" href="/files/${id}/download">Скачать оригинал</a>
<a class="btn" href="/files/${id}/view" target="_blank" rel="noopener">Открыть оригинал в новой вкладке</a>
<a class="btn" href="/files?login=${encodeURIComponent(f.owner)}">Все файлы: ${esc(f.owner)}</a>
<a class="btn" href="/files?from=${esc(day)}&to=${esc(day)}">Все файлы за ${esc(day)}</a>
<a class="btn" href="/files?q=${encodeURIComponent(f.name)}">Файлы с таким именем</a></div>
<p class="muted">Раздать, передать или забрать в сейф можно у альбома: нажмите на название альбома выше.</p></aside></div>`, '', SCRIPT);
}

// Передача альбома: подтверждение с точными числами. Само действие делает кнопка внизу (POST).
export function transferConfirmPage({ album, login, preview, csrf, flash, loadError }) {
  const id = encodeURIComponent(album.id);
  return layout('DV Cloud: передать альбом', `
${topBar('sharing', csrf)}
${flashHtml(flash, loadError)}
<section class="panel"><h2>Передать альбом «${esc(album.name)}» человеку ${esc(login)}?</h2>
<p>Сейчас владелец: <b>${esc(preview.owner)}</b>. Файлов в альбоме: <b>${preview.files}</b>.</p>
<div class="msg error"><b>Файлы уйдут вместе с альбомом.</b> У ${esc(preview.owner)} они исчезнут полностью${preview.inOtherAlbums ? `, в том числе из её/его других альбомов: <b>${preview.inOtherAlbums}</b>` : ''}. Доступа к ним у прежнего владельца не останется. Место освободится у ${esc(preview.owner)} и займётся у ${esc(login)}.</div>
<p class="muted">На диске файлы остаются в одном экземпляре. Если у ${esc(login)} такой же файл уже есть, второй не создаётся.</p>
<form method="post" action="/sharing/${id}/transfer">${csrfInput(csrf)}<input type="hidden" name="login" value="${esc(login)}"><input type="hidden" name="confirm" value="1">
<button class="danger" type="submit">Да, передать</button> <a class="btn" href="/sharing">Отмена</a></form></section>`);
}

// ── Раздача альбомов: кому открыт каждый альбом, открыть одному, всем или всё всем ──
const KIND_NAME = { any: 'Универсальный', photos: 'Фото', videos: 'Видео', screenshots: 'Скриншоты' };

// «Альбомы людям»: карточка на каждый альбом. Название крупно, под ним владелец, тип и число файлов. Кому открыт: флажки напротив людей.
// «Ещё»: передать другому человеку или забрать у владельца в сейф (по паролю админки).
export function sharingPage({ albums, users, csrf, flash, loadError, filter = {} }) {
  const active = users.filter((u) => !u.disabled);
  const q = String(filter.q ?? '').trim().toLowerCase();
  const shown = albums.filter((a) => (!filter.owner || a.owner === filter.owner) && (!filter.kind || (a.kind ?? 'any') === filter.kind) && (!q || a.name.toLowerCase().includes(q)));
  const owners = [...new Set(albums.map((a) => a.owner))].sort();
  const cards = shown.map((a) => {
    const id = encodeURIComponent(a.id);
    const others = active.filter((u) => u.login !== a.owner);
    const boxes = others.map((u) => `<label class="pick"><input type="checkbox" name="login" value="${esc(u.login)}"${a.logins.includes(u.login) ? ' checked' : ''}> ${esc(u.displayName || u.login)}</label>`).join('');
    const opts = others.map((u) => `<option value="${esc(u.login)}">${esc(u.displayName || u.login)}</option>`).join('');
    return `<li class="acard">
<div class="achead"><h3>${esc(a.name)}</h3><div class="achips"><span class="chip">${esc(KIND_NAME[a.kind ?? 'any'] ?? 'Универсальный')}</span><span class="chip">${esc(a.count)} файлов</span>${a.logins.length ? `<span class="chip ok">открыт: ${esc(a.logins.length)}</span>` : '<span class="chip">никому не открыт</span>'}</div>
<p class="muted">Владелец: <b>${esc(a.owner)}</b></p></div>
<form method="post" action="/sharing/${id}/set">${csrfInput(csrf)}
<fieldset class="apeople"><legend>Кому открыт</legend>${boxes || '<span class="muted">Других людей в облаке нет.</span>'}</fieldset>
${others.length ? `<div class="acact"><button class="primary" type="submit">Сохранить доступ</button> <button type="submit" formaction="/sharing/${id}/all">Открыть всем</button>${a.logins.length ? ` <button class="danger" type="submit" formaction="/sharing/${id}/hide">Скрыть у всех</button>` : ''}</div>` : ''}
</form>
<details class="amore"><summary>Передать другому или забрать у владельца</summary>
<div class="amoreb">
${others.length ? `<form method="get" action="/sharing/${id}/transfer"><p><b>Передать другому человеку (смена владельца).</b> У него появится такой же альбом с теми же файлами (они считаются в его место). У прежнего владельца исчезнут и альбом, и сами файлы, в том числе из его других альбомов. На диске файлы остаются. Перед передачей будет страница подтверждения с числами.</p><select name="login" aria-label="Кому передать">${opts}</select> <button type="submit">Передать…</button></form>` : ''}
<form method="post" action="/sharing/${id}/vault">${csrfInput(csrf)}<p><b>Забрать у владельца в сейф.</b> Альбом и его файлы исчезнут у ${esc(a.owner)} полностью (место освободится), файлы будут лежать в сейфе, защищённые от стирания. Достать их можно только по паролю админки.</p>
<input type="text" name="note" maxlength="300" placeholder="Заметка (необязательно)" aria-label="Заметка к альбому в сейфе"> <input type="password" name="password" placeholder="Пароль админки" autocomplete="current-password" required aria-label="Пароль админки"> <button class="danger" type="submit">В сейф</button></form>
</div></details></li>`;
  }).join('');
  return layout('DV Cloud: альбомы людям', `
${topBar('sharing', csrf)}
${flashHtml(flash, loadError)}
<section class="panel"><div class="panel-head"><div><h2>Раздать всё всем ${info(['Каждый альбом каждого человека откроется всем остальным людям. Люди увидят чужие альбомы у себя и смогут сохранить файлы себе, но не смогут их менять.','Место на диске при этом не тратится: файл остаётся в одном экземпляре.','Действие можно отменить только вручную, снимая доступ по альбомам ниже. Поэтому нужно ввести слово.'])}</h2><p class="muted">Чтобы в семье все видели альбомы друг друга.</p></div></div>
<form method="post" action="/sharing/everything">${csrfInput(csrf)}<input type="text" name="word" placeholder="впишите: раздать" autocomplete="off" required aria-label="Подтверждение: впишите слово раздать"> <button class="primary" type="submit">Открыть все альбомы всем</button></form></section>
<section class="panel"><div class="panel-head"><div><h2>Альбомы ${info(['Отметьте флажками, кому открыт каждый альбом, и нажмите «Сохранить доступ». Снятый флажок закрывает доступ, отмеченный открывает.','Люди видят чужие альбомы у себя и могут сохранить файлы себе; менять альбом они не могут. Новые файлы, которые владелец добавит позже, видны сразу: это не копия.','«Открыть всем» отмечает всех, «Скрыть у всех» снимает все доступы (альбом остаётся у хозяина).','«Передать другому» меняет владельца: файлы уходят вместе с альбомом и у прежнего владельца пропадают полностью. «В сейф» забирает альбом и файлы у владельца целиком: они пропадают у людей и лежат в сейфе под защитой.'])}</h2><p class="muted">Показано альбомов: ${shown.length} из ${albums.length}.</p></div></div>
<form class="afilter" method="get" action="/sharing"><select name="owner" aria-label="Владелец"><option value="">Все владельцы</option>${owners.map((o) => `<option value="${esc(o)}"${filter.owner === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>
<select name="kind" aria-label="Тип альбома"><option value="">Любой тип</option>${Object.entries(KIND_NAME).map(([k, n]) => `<option value="${k}"${filter.kind === k ? ' selected' : ''}>${n}</option>`).join('')}</select>
<input type="search" name="q" value="${esc(filter.q ?? '')}" placeholder="Название альбома" aria-label="Поиск по названию"> <button type="submit">Показать</button></form>
<ul class="acards">${cards || '<li class="muted">Альбомов нет.</li>'}</ul></section>`);
}

// «Сейф»: альбомы, забранные у владельцев. Достать или стереть только по паролю админки.
export function vaultPage({ albums, users, csrf, flash, loadError }) {
  const active = users.filter((u) => !u.disabled);
  const opts = active.map((u) => `<option value="${esc(u.login)}">${esc(u.displayName || u.login)}</option>`).join('');
  const rows = albums.map((v) => {
    const id = encodeURIComponent(v.id);
    return `<li class="acard">
<div class="achead"><h3>${esc(v.name)}</h3><div class="achips"><span class="chip">${esc(v.count)} файлов</span><span class="chip">${esc(formatSize(v.bytes))}</span></div>
<p class="muted">Забран у: <b>${esc(v.fromLogin)}</b> · ${esc(String(v.createdAt).slice(0, 10))}${v.note ? ` · ${esc(v.note)}` : ''}</p></div>
<details class="amore"><summary>Вернуть или стереть (нужен пароль админки)</summary><div class="amoreb">
<form method="post" action="/vault/${id}/return">${csrfInput(csrf)}<p><b>Вернуть человеку.</b> Альбом и файлы появятся у него (с прежними именами и датами), из сейфа они уйдут.</p><select name="login" aria-label="Кому вернуть">${opts}</select> <input type="password" name="password" placeholder="Пароль админки" autocomplete="current-password" required aria-label="Пароль админки"> <button type="submit">Вернуть</button></form>
<form method="post" action="/vault/${id}/erase">${csrfInput(csrf)}<p><b>Стереть насовсем.</b> Файлы будут удалены с диска, вернуть их нельзя (кроме тех, что есть у других людей).</p><input type="password" name="password" placeholder="Пароль админки" autocomplete="current-password" required aria-label="Пароль админки"> <button class="danger" type="submit">Стереть навсегда</button></form>
</div></details></li>`;
  }).join('');
  return layout('DV Cloud: сейф', `
${topBar('vault', csrf)}
${flashHtml(flash, loadError)}
<section class="panel"><div class="panel-head"><div><h2>Сейф ${info(['Здесь лежат альбомы, которые вы забрали у владельцев кнопкой «В сейф» на вкладке «Альбомы людям». Люди их не видят и не могут удалить.','Файлы сейфа защищены от стирания на всех путях: очистка корзины, чистка файлов без владельца, поиск дубликатов их не трогают. Стереть можно только отсюда, по паролю админки.','В резервную копию сейф входит как все остальные файлы.','Защита от человека с доступом к самому серверу (root) не даётся: для этого нужно шифрование с ключом вне сервера.'])}</h2><p class="muted">Альбомов в сейфе: ${albums.length}.</p></div></div>
<ul class="acards">${rows || '<li class="muted">Сейф пуст. Положить альбом можно на вкладке «Альбомы людям».</li>'}</ul></section>`);
}

// ── Резервная копия: куда, что копировать, запуск по кнопке, ход ──
const when = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 16) : '—');

export function backupPage({ b, csrf, flash, loadError }) {
  const c = b?.config;
  const job = b?.job;
  const last = b?.last;
  const running = job?.state === 'running';
  const res = (j) => { const r = j?.result; if (!r) return ''; const parts = []; if (r.bytes > 0 || r.files > 0) parts.push(`точная копия: передано файлов ${esc(r.files)}, всего ${esc(formatSize(r.bytes))}${r.pending ? `, ещё не догнано (новое за время копии): ${esc(r.pending)}` : ', проверено: расхождений нет'}`); if (r.readable > 0) parts.push(`по людям: ${esc(r.readable)} файлов`); if (r.dumpBytes > 0) parts.push(`база: ${esc(formatSize(r.dumpBytes))}`); return parts.join('; ') || 'готово'; };
  const statusPanel = b ? `<section class="panel"><div class="panel-head"><div><h2>Состояние ${info(['Копия запускается только вашей кнопкой, сама по расписанию не идёт.','Во время копирования облако работает как обычно: копия идёт в фоне с самым низким приоритетом. Страница обновляется сама, её можно закрыть.','Каждый раз копируются только новые и изменённые файлы, поэтому повторная копия быстрая. Удалённые вами файлы из копии не стираются: это страховка от случайного удаления.','После копирования выполняется проверка: файлы на месте назначения сверяются с облаком по размеру.'])}</h2>
<p class="muted">${running ? 'Идёт копирование.' : last ? 'Последний запуск закончен.' : 'Копия ещё не делалась.'}</p></div>
<div>${post(csrf, '/backup/check', {}, 'Проверить место')}<form class="inline" method="post" action="/backup/start">${csrfInput(csrf)}<button class="primary" type="submit"${running ? ' disabled' : ''}>${running ? 'Идёт…' : 'Сделать копию сейчас'}</button></form></div></div>
${running ? `<p role="status"><b>${esc(job.step)}</b>${job.percent !== null ? `, ${esc(job.percent)}%` : ''}. Начато ${esc(when(job.startedAt))}.</p><progress max="100" value="${esc(job.percent ?? 0)}" aria-label="Ход копирования"></progress>` : ''}
${!running && job?.state === 'error' ? `<div class="msg error" role="alert"><b>Копия не получилась.</b> ${esc(job.error ?? '')}</div>` : ''}
${!running && last?.state === 'done' ? `<p>Последняя удачная: <b>${esc(when(last.finishedAt))}</b>, ${res(last)}. Место: ${esc(last.result?.destination ?? '')}.</p>` : ''}
${!running && last?.state === 'error' && !job ? `<div class="msg error"><b>Прошлая копия не получилась</b> (${esc(when(last.finishedAt))}): ${esc(last.error ?? '')}</div>` : ''}
</section>` : '';
  const chip = (on) => (on ? '<span class="chip ok">выбрано</span>' : '');
  const folderCard = c ? `<section class="panel"><form method="post" action="/backup/folder">${csrfInput(csrf)}<div class="panel-head"><div><h2>Диск или папка ${chip(c.kind === 'folder')} ${info(['Подходит для внешнего диска (USB), второго диска в компьютере и сетевой папки (NAS, другой компьютер дома).','Облако видит одну папку, куда подключён такой диск. Подключить диск к облаку нужно один раз на самом сервере (это делается через настройки сервера, не из админки): в инструкции по копии это раздел «Подключить диск».','Здесь можно указать подпапку на этом диске, например <b>dvcloud</b>. Пусто — копия ляжет в корень диска, в папку <b>dvcloud-backup</b>.','Если ниже написано, что диск не подключён, сначала подключите его, и только потом запускайте копию.'])}</h2>
<p class="muted">USB-диск, второй диск или сетевая папка, подключённые к серверу.</p></div></div>
${b.rootAvailable ? '<p class="muted">Диск для копий подключён.</p>' : c.kind !== 'folder' ? '' : '<div class="msg error">Диск для копий не подключён к облаку. Подробнее в «Инфо» выше.</div>'}
<div class="setting"><div><b>Подпапка на диске</b> ${info('Необязательно. Латиница, цифры, пробел, точка и дефис. Например: dvcloud')}</div><input type="text" name="folder" value="${esc(c.folder)}" maxlength="64" placeholder="например dvcloud" aria-label="Подпапка на диске"></div>
<p><button class="primary" type="submit">Выбрать этот способ</button></p></form></section>
<section class="panel"><form method="post" action="/backup/ssh">${csrfInput(csrf)}<div class="panel-head"><div><h2>Другой сервер по SSH ${chip(c.kind === 'ssh')} ${info(['Копия уходит на другой компьютер или сервер через SSH — защищённое соединение по ключу, пароль нигде не вводится.','<b>Адрес сервера</b> — IP или имя компьютера, куда копировать. <b>Порт</b> — обычно 22. <b>Пользователь</b> — под кем входить на том сервере. <b>Папка на сервере</b> — полный путь, например /srv/dvcloud-backup; её создадут сами.','Ниже показан <b>открытый ключ</b> облака. Его нужно один раз добавить на том сервере в файл ~/.ssh/authorized_keys пользователя. Открытый ключ не секрет, его можно копировать.','Закрытый ключ остаётся внутри облака и нигде не показывается. Первое подключение запоминает отпечаток сервера; если он потом изменится, копирование остановится.'])}</h2>
<p class="muted">Другой компьютер или удалённый сервер.</p></div></div>
<div class="setting"><div><b>Адрес сервера</b> ${info('IP-адрес (например 192.168.1.20) или имя (например backup.example.org).')}</div><input type="text" name="host" value="${esc(c.host)}" maxlength="253" aria-label="Адрес сервера"></div>
<div class="setting"><div><b>Порт</b> ${info('Обычно 22. Другой, если на сервере SSH настроен иначе.')}</div><input class="narrow" type="number" name="port" min="1" max="65535" value="${esc(c.port)}" aria-label="Порт"></div>
<div class="setting"><div><b>Пользователь</b> ${info('Под каким пользователем входить на сервер. Ему нужно право записи в папку ниже.')}</div><input type="text" name="user" value="${esc(c.user)}" maxlength="32" aria-label="Пользователь"></div>
<div class="setting"><div><b>Папка на сервере</b> ${info('Полный путь: латиница, цифры и . _ / ~ + @ -, без пробелов. Папка создаётся сама.')}</div><input type="text" name="path" value="${esc(c.path)}" maxlength="200" placeholder="/srv/dvcloud-backup" aria-label="Папка на сервере"></div>
<div class="setting"><div><b>Открытый ключ облака</b> ${info('Скопируйте эту строку целиком и добавьте новой строкой в файл ~/.ssh/authorized_keys пользователя на сервере назначения. Это открытая часть ключа: показывать её безопасно.')}</div></div>
${b.publicKey ? `<div class="secret" style="font-size:13px">${esc(b.publicKey)}</div>` : '<p class="muted">Ключ появится после сохранения этого способа.</p>'}
<p><button class="primary" type="submit">Выбрать этот способ</button></p></form></section>
<section class="panel"><form method="post" action="/backup/options">${csrfInput(csrf)}<h2>Что копировать ${info(['Отметьте, что входит в копию. Можно взять только файлы, только базу или всё вместе.','<b>Файлы</b> — ваши фото и видео. <b>База данных</b> — люди, альбомы, группы людей, настройки: без неё после восстановления файлы лежат, но облако не знает, чьи они и в каких альбомах.','Для полного восстановления облака нужны и файлы (точная копия), и база.'])}</h2>
<div class="setting"><div><b>Фото и видео</b></div><label class="switch"><input type="checkbox" name="withFiles" value="1"${c.withFiles ? ' checked' : ''}><span>Да</span></label></div>
<div class="setting"><div><b>База данных</b></div><label class="switch"><input type="checkbox" name="withDb" value="1"${c.withDb ? ' checked' : ''}><span>Да</span></label></div>
<h2 style="margin-top:14px">Как копировать файлы ${info(['<b>Точная копия</b> — файлы лежат так же, как в облаке (папка files). Из неё облако восстанавливается целиком. Это основной вариант.','<b>Копия по людям</b> — понятная раскладка для человека: папка на каждого, внутри годы и месяцы, нормальные имена. Её можно открыть без облака, например на компьютере. Для восстановления облака она не нужна. Файлы в ней настоящие, места нужно столько же, сколько и под точную копию, ведь одинаковые фото разных людей повторяются.','Можно включить обе.','Если вы позже поменяете раскладку или имена, прежняя раскладка в копии останется: старые папки сами не стираются.'])}</h2>
<div class="setting"><div><b>Точная копия (для восстановления)</b></div><label class="switch"><input type="checkbox" name="mirror" value="1"${c.mirror ? ' checked' : ''}><span>Да</span></label></div>
<div class="setting"><div><b>Копия по людям (смотреть без облака)</b></div><label class="switch"><input type="checkbox" name="readable" value="1"${c.readable ? ' checked' : ''}><span>Да</span></label></div>
<div class="setting"><div><b>Подпапки в копии по людям</b> ${info(`Как раскладывать файлы каждого человека: все в одной папке, по годам (2026) или по годам и месяцам (2026/05). Для больших библиотек удобнее месяцы.`)}</div><select name="folders" aria-label="Подпапки в копии по людям"><option value="none"${c.folders === 'none' ? ' selected' : ''}>без подпапок</option><option value="year"${c.folders === 'year' ? ' selected' : ''}>по годам</option><option value="month"${c.folders === 'month' ? ' selected' : ''}>по годам и месяцам</option></select></div>
<div class="setting"><div><b>Имена файлов в копии по людям</b> ${info(`«С датой впереди» делает имена вида 2026-05-10_123000_IMG_1.jpg: они сортируются по времени съёмки даже в самой простой программе. Одинаковые имена получают « (2)».`)}</div><select name="names" aria-label="Имена файлов в копии по людям"><option value="original"${c.names === 'original' ? ' selected' : ''}>как в облаке</option><option value="date"${c.names === 'date' ? ' selected' : ''}>с датой впереди</option></select></div>
<div class="setting"><div><b>Папки по альбомам в копии по людям</b> ${info(`Рядом с папкой people появится папка albums: для каждого альбома своя папка с его файлами.`)}</div><label class="switch"><input type="checkbox" name="withAlbums" value="1"${c.withAlbums ? ' checked' : ''}><span>Да</span></label></div>
<h2 style="margin-top:14px">Дополнительно</h2>
<div class="setting"><div><b>Точная копия: и то, что в корзинах</b> ${info(`Если выключить, файлы, удалённые людьми в корзину, в точную копию не попадут.`)}</div><label class="switch"><input type="checkbox" name="withTrash" value="1"${c.withTrash ? ' checked' : ''}><span>Да</span></label></div>
<div class="setting"><div><b>Точная копия: миниатюры и копии видео</b> ${info(`Облако строит их само, обычно их не копируют: это сильно экономит место. После восстановления они построятся заново.`)}</div><label class="switch"><input type="checkbox" name="withDerived" value="1"${c.withDerived ? ' checked' : ''}><span>Да</span></label></div>
<div class="setting"><div><b>Ограничение скорости, Мбит/с</b> ${info('0 — без ограничения. Для копии на другой сервер по интернету разумно поставить, например, 20.')}</div><input class="narrow" type="number" name="limitMbit" min="0" max="10000" value="${esc(c.limitMbit)}" aria-label="Ограничение скорости, Мбит/с"></div>
<p><button class="primary" type="submit">Сохранить</button></p></form></section>` : '';
  return layout('DV Cloud: копия', `
${topBar('backup', csrf)}
${flashHtml(flash, loadError)}
${statusPanel}
${folderCard}
<section class="panel"><h2>Как восстановить из копии ${info(['В копии лежат две части: папка <b>files</b> (все фото и видео как они лежат в облаке) и папка <b>db</b> (выгрузки базы данных, последние семь).','Восстановление делается на сервере и описано по шагам в файле docs/BACKUP.md в репозитории облака.','Проверить, что выгрузка читается, можно командой pg_restore --list на файле из папки db.'])}</h2>
<p class="muted">Пошаговая инструкция лежит в docs/BACKUP.md.</p></section>`, running ? '<meta http-equiv="refresh" content="3">' : '');
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

// Маленький скрипт для просмотра: стрелки и Esc, приближение удержанием ЛЕВОЙ кнопки (без меню браузера). Своё, без библиотек.
export const VIEWER_JS = `(function () {
  document.documentElement.classList.add('js');
  var held = null;
  function release() { if (held) { held.classList.remove('hold'); held = null; } }
  function grab(el) { release(); held = el; el.classList.add('hold'); }
  function zoomOf(t) { return t && t.closest ? t.closest('.zoomhold') : null; }
  document.addEventListener('mousedown', function (e) { var z = zoomOf(e.target); if (z && e.button === 0) { grab(z); e.preventDefault(); } });
  document.addEventListener('mouseup', release);
  document.addEventListener('touchstart', function (e) { var z = zoomOf(e.target); if (z) grab(z); }, { passive: true });
  document.addEventListener('touchend', release);
  document.addEventListener('touchcancel', release);
  window.addEventListener('blur', release);
  document.addEventListener('contextmenu', function (e) { if (zoomOf(e.target) || (e.target.closest && e.target.closest('.zoombox'))) e.preventDefault(); });
  document.addEventListener('dragstart', function (e) { if (zoomOf(e.target)) e.preventDefault(); });
  document.addEventListener('keydown', function (e) {
    var t = e.target && e.target.tagName;
    if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return;
    var a = null;
    if (e.key === 'ArrowLeft') a = document.querySelector('a[rel=prev]');
    else if (e.key === 'ArrowRight') a = document.querySelector('a[rel=next]');
    else if (e.key === 'Escape') a = document.querySelector('a[data-back]');
    if (a) { e.preventDefault(); location.href = a.href; }
  });
})();
`;
