import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';

test('значения по умолчанию: только localhost, порт 3004', () => {
  const c = loadConfig({ DVCLOUD_DATABASE_URL: 'postgres://x' });
  assert.equal(c.port, 3004);
  assert.equal(c.host, '127.0.0.1');
});

test('без адреса базы конфигурация не собирается', () => {
  assert.throws(() => loadConfig({}), /DVCLOUD_DATABASE_URL/);
});

test('плохой порт отвергается', () => {
  assert.throws(() => loadConfig({ DVCLOUD_DATABASE_URL: 'x', DVCLOUD_PORT: '70000' }), /DVCLOUD_PORT/);
});
