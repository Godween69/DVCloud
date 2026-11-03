import { test } from 'node:test';
import assert from 'node:assert/strict';
import { databaseUrlFrom, loadConfig } from '../src/config';

const TOKEN = 'x'.repeat(32);
const base = { DVCLOUD_DATABASE_URL: 'postgres://x', DVCLOUD_INTERNAL_TOKEN: TOKEN };

test('значения по умолчанию: только localhost, порты 3004 и 3006, кука Secure', () => {
  const c = loadConfig(base);
  assert.equal(c.port, 3004);
  assert.equal(c.internalPort, 3006);
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.internalHost, '127.0.0.1');
  assert.equal(c.cookieSecure, true);
  assert.equal(c.trustProxy, 0);
});

test('без адреса базы конфигурация не собирается', () => {
  assert.throws(() => loadConfig({ DVCLOUD_INTERNAL_TOKEN: TOKEN }), /DVCLOUD_DATABASE_URL/);
  assert.throws(() => databaseUrlFrom({}), /DVCLOUD_DATABASE_URL/);
});

test('короткий внутренний токен отвергается', () => {
  assert.throws(() => loadConfig({ ...base, DVCLOUD_INTERNAL_TOKEN: 'short' }), /DVCLOUD_INTERNAL_TOKEN/);
});

test('плохой порт отвергается, одинаковые порты тоже', () => {
  assert.throws(() => loadConfig({ ...base, DVCLOUD_PORT: '70000' }), /DVCLOUD_PORT/);
  assert.throws(() => loadConfig({ ...base, DVCLOUD_PORT: '3006' }), /различаться/);
});

test('кука Secure отключается только явным false', () => {
  assert.equal(loadConfig({ ...base, DVCLOUD_COOKIE_SECURE: 'false' }).cookieSecure, false);
  assert.equal(loadConfig({ ...base, DVCLOUD_COOKIE_SECURE: 'no' }).cookieSecure, true);
});

test('второй фактор: адрес и секрет DV Auth задаются вместе, секрет не короче 32 символов', () => {
  assert.equal(loadConfig(base).authUrl, '');
  assert.throws(() => loadConfig({ ...base, DVCLOUD_AUTH_URL: 'http://127.0.0.1:3011' }), /вместе/);
  assert.throws(() => loadConfig({ ...base, DVCLOUD_AUTH_SECRET: 'x'.repeat(32) }), /вместе/);
  assert.throws(() => loadConfig({ ...base, DVCLOUD_AUTH_URL: 'ftp://x', DVCLOUD_AUTH_SECRET: 'x'.repeat(32) }), /http/);
  assert.throws(() => loadConfig({ ...base, DVCLOUD_AUTH_URL: 'http://x', DVCLOUD_AUTH_SECRET: 'short' }), /32/);
  const c = loadConfig({ ...base, DVCLOUD_AUTH_URL: 'http://127.0.0.1:3011/', DVCLOUD_AUTH_SECRET: 'x'.repeat(32) });
  assert.equal(c.authUrl, 'http://127.0.0.1:3011');
});
