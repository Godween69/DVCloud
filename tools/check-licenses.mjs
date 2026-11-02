// Проверка лицензий зависимостей. Политика: MIT, BSD, Apache-2.0, MPL-2.0 разрешены;
// ISC, 0BSD и подобные разрешены, но показываются в отчёте; AGPL/GPL и неизвестные — ошибка.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWED = new Set(['MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'MPL-2.0']);
const VISIBLE = new Set(['ISC', '0BSD', 'BlueOak-1.0.0', 'Unlicense', 'CC0-1.0', 'Python-2.0', 'CC-BY-4.0']);
const FORBIDDEN = /GPL/i;

// Правило для одного SPDX-идентификатора: 'ok' | 'visible' | 'bad'
function rate(id) {
  const x = id.replace(/\+$/, '');
  if (FORBIDDEN.test(x)) return 'bad';
  if (ALLOWED.has(x)) return 'ok';
  if (VISIBLE.has(x)) return 'visible';
  return 'bad';
}

// Выражение вида "(MIT OR Apache-2.0)" или "MIT AND ISC": OR — лучшее из вариантов, AND — худшее.
export function rateExpression(expr) {
  const order = { ok: 0, visible: 1, bad: 2 };
  const s = String(expr || '').trim().replace(/^\(|\)$/g, '');
  if (!s) return 'bad';
  const ors = s.split(/\s+OR\s+/i).map((part) => {
    const ands = part.replace(/[()]/g, '').split(/\s+AND\s+/i).map((i) => rate(i.trim()));
    return ands.sort((a, b) => order[b] - order[a])[0];
  });
  return ors.sort((a, b) => order[a] - order[b])[0];
}

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const p = join(dir, name);
    if (name.startsWith('@')) {
      yield* walk(p);
      continue;
    }
    const pj = join(p, 'package.json');
    if (existsSync(pj)) {
      yield JSON.parse(readFileSync(pj, 'utf8'));
      yield* walk(join(p, 'node_modules'));
    }
  }
}

function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type).join(' OR ');
  return '';
}

export function check(root) {
  const seen = new Map();
  for (const pkg of walk(join(root, 'node_modules'))) {
    if (!pkg.name || !pkg.version || pkg.name.startsWith('@dvcloud/')) continue;
    seen.set(`${pkg.name}@${pkg.version}`, licenseOf(pkg));
  }
  const visible = [];
  const bad = [];
  const counts = {};
  for (const [id, lic] of [...seen].sort()) {
    const r = rateExpression(lic);
    counts[lic || '(нет)'] = (counts[lic || '(нет)'] ?? 0) + 1;
    if (r === 'visible') visible.push(`${id}  ${lic}`);
    if (r === 'bad') bad.push(`${id}  ${lic || '(лицензия не указана)'}`);
  }
  return { total: seen.size, counts, visible, bad };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2] ?? process.cwd();
  const { total, counts, visible, bad } = check(root);
  console.log(`Пакетов проверено: ${total}`);
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
  if (visible.length) console.log(`\nТребуют внимания (разрешены, но видны в отчёте): ${visible.length}\n  ${visible.join('\n  ')}`);
  if (bad.length) {
    console.error(`\nЗАПРЕЩЕНО или неизвестно: ${bad.length}\n  ${bad.join('\n  ')}`);
    process.exit(1);
  }
  console.log('\nЛицензии в порядке.');
}
