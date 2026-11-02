import { join } from 'node:path';
import { Client } from 'pg';
import { databaseUrlFrom } from '../config';
import { migrate } from './migrate';

async function main(): Promise<void> {
  const client = new Client({ connectionString: databaseUrlFrom() });
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
