// Простые SQL-миграции без ORM: файлы NNNN_имя.sql по порядку, каждая в транзакции.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from 'pg';

const NAME_RE = /^\d{4}_[a-z0-9_]+\.sql$/;

export function listMigrations(dir: string): string[] {
  return readdirSync(dir).filter((f) => NAME_RE.test(f)).sort();
}

export async function migrate(client: Client, dir: string): Promise<string[]> {
  await client.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const done = new Set(
    (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );
  const applied: string[] = [];
  for (const name of listMigrations(dir)) {
    if (done.has(name)) continue;
    const sql = readFileSync(join(dir, name), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`Миграция ${name} не применилась: ${e instanceof Error ? e.message : e}`);
    }
    applied.push(name);
  }
  return applied;
}
