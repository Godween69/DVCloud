import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, formatQuota, parseQuotaGb } from '../lib/html.mjs';
import { upsertEnvLine } from '../lib/envfile.mjs';
import { createLimiter } from '../lib/ratelimit.mjs';
import { createSessions } from '../lib/sessions.mjs';
import { loadAdminConfig } from '../lib/config.mjs';

test('esc экранирует всё опасное', () => {
  assert.equal(esc(`<img src=x onerror="a('b')">&`), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
});

test('квота: гигабайты в байты и обратно, мусор отвергается', () => {
  assert.equal(parseQuotaGb(''), null);
  assert.equal(parseQuotaGb('500'), 500 * 1024 ** 3);
  assert.equal(parseQuotaGb('1,5'), Math.round(1.5 * 1024 ** 3));
  assert.equal(parseQuotaGb('-5'), undefined);
  assert.equal(parseQuotaGb('много'), undefined);
  assert.equal(formatQuota(null), 'без лимита');
  assert.equal(formatQuota(500 * 1024 ** 3), '500 ГБ');
});

test('строка окружения заменяется или добавляется, остальное не трогается', () => {
  assert.equal(upsertEnvLine('A=1\n', 'K', 'v$1'), "A=1\nK='v$1'\n");
  assert.equal(upsertEnvLine("A=1\nK='old'\nB=2\n", 'K', 'new'), "A=1\nK='new'\nB=2\n");
  assert.equal(upsertEnvLine('A=1', 'K', 'v'), "A=1\nK='v'\n");
  assert.throws(() => upsertEnvLine('', 'K', "a'b"));
});

test('ограничитель: после max неудач блокирует, через окно отпускает', () => {
  let t = 0;
  const l = createLimiter({ max: 3, windowMs: 1000, now: () => t });
  for (let i = 0; i < 3; i++) l.fail('ip');
  assert.ok(l.blocked('ip'));
  assert.ok(!l.blocked('other'));
  t = 1500;
  assert.ok(!l.blocked('ip'));
});

test('сессия истекает по простою и по предельному сроку', () => {
  let t = 0;
  const s = createSessions({ idleMs: 100, maxMs: 1000, now: () => t });
  const a = s.create();
  t = 50;
  assert.ok(s.get(a.token));
  t = 200;
  assert.equal(s.get(a.token), null);
  const b = s.create();
  for (t = 300; t < 1300; t += 90) s.get(b.token);
  assert.equal(s.get(b.token), null);
  assert.equal(s.get(undefined), null);
});

test('конфигурация требует токен и хеш пароля', () => {
  const ok = { DVCLOUD_INTERNAL_TOKEN: 'x'.repeat(32), DVCLOUD_ADMIN_PASSWORD_HASH: 'scrypt$1$a$b' };
  assert.equal(loadAdminConfig(ok).host, '127.0.0.1');
  assert.equal(loadAdminConfig(ok).port, 3005);
  assert.throws(() => loadAdminConfig({ ...ok, DVCLOUD_INTERNAL_TOKEN: 'short' }), /TOKEN/);
  assert.throws(() => loadAdminConfig({ ...ok, DVCLOUD_ADMIN_PASSWORD_HASH: '' }), /PASSWORD_HASH/);
  assert.throws(() => loadAdminConfig({ ...ok, DVCLOUD_INTERNAL_URL: 'https://x' }), /INTERNAL_URL/);
});
