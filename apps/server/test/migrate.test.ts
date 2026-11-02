import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listMigrations } from '../src/db/migrate';

test('миграции берутся только по маске и идут по порядку', () => {
  const d = mkdtempSync(join(tmpdir(), 'mig-'));
  for (const f of ['0002_b.sql', '0001_a.sql', 'notes.txt', '3_bad.sql']) writeFileSync(join(d, f), '');
  assert.deepEqual(listMigrations(d), ['0001_a.sql', '0002_b.sql']);
});
