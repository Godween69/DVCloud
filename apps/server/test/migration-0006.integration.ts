// Миграция 0006 на данных, созданных версиями 0001–0005: дубликаты между людьми, скрытые файлы, альбомы.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';
import { migrate } from '../src/db/migrate';
import { mkdtempSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ADMIN = process.env.DVCLOUD_TEST_DATABASE_URL ?? '';
const DIR = join(__dirname, '..', '..', 'migrations');

test('миграция 0006: одно содержимое — один blob, ссылки и альбомы сохраняются, ничего не удаляется', async () => {
  const name = `dvcloud_mig_${randomBytes(4).toString('hex')}`;
  const admin = new Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const u = new URL(ADMIN);
  u.pathname = `/${name}`;
  const c = new Client({ connectionString: u.toString() });
  await c.connect();
  try {
    // только старые миграции
    const old = mkdtempSync(join(tmpdir(), 'mig-old-'));
    for (const f of readdirSync(DIR).filter((x) => /^000[1-5]_/.test(x))) copyFileSync(join(DIR, f), join(old, f));
    await migrate(c, old);
    const h1 = 'a'.repeat(64);
    const h2 = 'b'.repeat(64);
    const users = await c.query(`INSERT INTO users (login, display_name, password_hash) VALUES ('anna','Анна','x'),('boris','Борис','x') RETURNING id`);
    const [anna, boris] = users.rows.map((r) => r.id);
    const ins = async (owner: number, path: string, sha: string, trashed: boolean) =>
      (await c.query(
        `INSERT INTO files (owner_id, path, original_name, mime, size_bytes, sha256, taken_at, trashed_at) VALUES ($1,$2,$3,'image/jpeg',100,$4,now(),${trashed ? 'now()' : 'NULL'}) RETURNING id`,
        [owner, path, path.split('/').pop(), sha],
      )).rows[0].id as number;
    const a1 = await ins(anna, 'library/anna/1.jpg', h1, false);
    const b1 = await ins(boris, 'library/boris/1.jpg', h1, false); // то же содержимое, другой человек, другой путь
    const a2 = await ins(anna, 'library/anna/2.jpg', h2, true); // только скрытый
    const alb = (await c.query(`INSERT INTO albums (owner_id, name) VALUES ($1,'A') RETURNING id`, [anna])).rows[0].id;
    await c.query('INSERT INTO album_files (album_id, file_id) VALUES ($1,$2),($1,$3)', [alb, a1, a2]);

    assert.deepEqual((await migrate(c, DIR)).slice(0, 1), ['0006_storage.sql']);

    const blobs = (await c.query('SELECT sha256, path FROM blobs ORDER BY sha256')).rows;
    assert.equal(blobs.length, 2);
    assert.equal(blobs[0].path, 'library/anna/1.jpg', 'основной — самый старый не скрытый');
    const links = (await c.query('SELECT id, blob_id FROM files ORDER BY id')).rows;
    assert.ok(links.every((l) => l.blob_id), 'у всех записей есть blob');
    assert.equal(links[0].blob_id, links[1].blob_id);
    assert.notEqual(links[0].blob_id, links[2].blob_id);
    // лишняя физическая копия записана, но не удалена
    assert.deepEqual((await c.query('SELECT path FROM blob_extra_paths')).rows.map((r) => r.path), ['library/boris/1.jpg']);
    assert.equal((await c.query('SELECT count(*)::int n FROM files')).rows[0].n, 3);
    // альбомы скопированы, старая таблица цела
    assert.equal((await c.query('SELECT count(*)::int n FROM album_items')).rows[0].n, 2);
    assert.equal((await c.query('SELECT count(*)::int n FROM album_files')).rows[0].n, 2);
    void b1;
    // повторный запуск ничего не делает
    assert.deepEqual(await migrate(c, DIR), []);
  } finally {
    await c.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
});
