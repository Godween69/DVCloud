import { join } from 'node:path';
import { Client } from 'pg';
import { loadConfig } from '../config';
import { migrate } from './migrate';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const client = new Client({ connectionString: cfg.databaseUrl });
  await client.connect();
  try {
    const applied = await migrate(client, join(__dirname, '..', '..', '..', 'migrations'));
    console.log(applied.length ? `Применено: ${applied.join(', ')}` : 'Новых миграций нет');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
