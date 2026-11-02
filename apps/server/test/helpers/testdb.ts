// Временная база для интеграционных тестов: создаётся, мигрируется и удаляется после тестов.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';
import { migrate } from '../../src/db/migrate';

export async function createTestDb(adminUrl: string): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `dvcloud_test_${randomBytes(4).toString('hex')}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  const url = u.toString();

  const c = new Client({ connectionString: url });
  await c.connect();
  await migrate(c, join(__dirname, '..', '..', '..', 'migrations'));
  await c.end();

  return {
    url,
    drop: async () => {
      const a = new Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}
