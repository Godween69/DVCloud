// Миграция 0020 (общие люди) на данных, которые лежали у каждого человека по-своему: копии таблиц, слияние
// одноимённых групп, пересборка безымянных, скрытие как личный выбор, одно назначение на лицо.
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

test('миграция 0020: одноимённые группы сливаются, ручное сохраняется, безымянные пересобираются, копии на месте', async () => {
  const name = `dvcloud_mig20_${randomBytes(4).toString('hex')}`;
  const admin = new Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const u = new URL(ADMIN);
  u.pathname = `/${name}`;
  const c = new Client({ connectionString: u.toString() });
  await c.connect();
  try {
    const old = mkdtempSync(join(tmpdir(), 'mig20-'));
    for (const f of readdirSync(DIR).filter((x) => /^\d{4}_/.test(x) && x < '0020')) copyFileSync(join(DIR, f), join(old, f));
    await migrate(c, old);
    const us = await c.query(`INSERT INTO users (login, display_name, password_hash) VALUES ('dima','Дима','x'),('valya','Валя','x') RETURNING id`);
    const [dima, valya] = us.rows.map((r) => r.id);
    const blob = async (n: number) => (await c.query(`INSERT INTO blobs (sha256, path, mime, size_bytes) VALUES ($1,$2,'image/jpeg',10) RETURNING id`, [String(n).padStart(64, '0'), `b/${n}.jpg`])).rows[0].id;
    const det = async (b: string) => (await c.query(`INSERT INTO detections (blob_id, kind, x, y, w, h, score, model, vector) VALUES ($1,'face',0,0,.1,.1,.9,'m',$2) RETURNING id`, [b, Buffer.alloc(8)])).rows[0].id as string;
    const person = async (owner: string, nm: string | null, hidden = false) => (await c.query('INSERT INTO people (owner_id, kind, name, hidden) VALUES ($1,\'person\',$2,$3) RETURNING id', [owner, nm, hidden])).rows[0].id as string;
    const link = (d: string, owner: string, p: string, src: string) => c.query('INSERT INTO detection_people (detection_id, owner_id, person_id, source) VALUES ($1,$2,$3,$4)', [d, owner, p, src]);

    const [b1, b2, b3, b4, b5] = [await blob(1), await blob(2), await blob(3), await blob(4), await blob(5)];
    const [d1, d2, d3, d4, d5] = [await det(b1), await det(b2), await det(b3), await det(b4), await det(b5)];
    const pDimaValya = await person(dima, 'Валя'); // у Димы «Валя»
    const pValyaValya = await person(valya, 'валя'); // у Вали она же, другой регистр
    const pValyaVasya = await person(valya, 'Вася', true); // личная и скрытая группа Вали
    const pAnon = await person(dima, null); // безымянная автоматическая: пересоберётся
    const pAnonManual = await person(dima, null); // безымянная, но правленная руками: остаётся
    await link(d1, dima, pDimaValya, 'manual');
    await link(d2, valya, pValyaValya, 'manual');
    await link(d3, valya, pValyaVasya, 'manual');
    await link(d4, dima, pAnon, 'auto');
    await link(d5, dima, pAnonManual, 'manual');
    await c.query('INSERT INTO detection_rejects (detection_id, owner_id, person_id) VALUES ($1,$2,$3),($1,$4,$5)', [d4, dima, pDimaValya, valya, pValyaValya]);

    assert.deepEqual((await migrate(c, DIR)).filter((x) => x === '0020_people_global.sql'), ['0020_people_global.sql']);

    // копии прежних таблиц целы
    assert.equal((await c.query('SELECT count(*)::int n FROM people_backup_0020')).rows[0].n, 5);
    assert.equal((await c.query('SELECT count(*)::int n FROM detection_people_backup_0020')).rows[0].n, 5);
    assert.equal((await c.query('SELECT count(*)::int n FROM detection_rejects_backup_0020')).rows[0].n, 2);

    // «Валя» и «валя» — одна группа (с меньшим номером), оба ручных лица в ней
    const people = (await c.query('SELECT id, name FROM people ORDER BY id')).rows;
    assert.deepEqual(people.map((p) => p.name), ['Валя', 'Вася', null], 'безымянная автоматическая стёрта, правленная вручную осталась');
    const valyaId = people[0].id;
    assert.deepEqual((await c.query('SELECT detection_id FROM detection_people WHERE person_id = $1 ORDER BY detection_id', [valyaId])).rows.map((r) => r.detection_id), [d1, d2]);
    // лицо из стёртой безымянной группы свободно: заново соберётся общим пересчётом
    assert.equal((await c.query('SELECT 1 FROM detection_people WHERE detection_id = $1', [d4])).rowCount, 0);
    // скрытие осталось личным: «Вася» скрыт у Вали и не скрыт у Димы
    const h = (await c.query('SELECT user_id, person_id FROM people_hidden')).rows;
    assert.deepEqual(h, [{ user_id: valya, person_id: pValyaVasya }]);
    // отказы слились в один
    assert.deepEqual((await c.query('SELECT person_id FROM detection_rejects WHERE detection_id = $1', [d4])).rows.map((r) => r.person_id), [valyaId]);
    // имя теперь уникально среди людей
    await assert.rejects(c.query("INSERT INTO people (kind, name) VALUES ('person', 'ВАЛЯ')"));
    // повторный запуск ничего не делает
    assert.deepEqual(await migrate(c, DIR), []);
  } finally {
    await c.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
});

test('миграция 0020: одно лицо у двух людей — остаётся одно назначение, ручное и названное важнее', async () => {
  const name = `dvcloud_mig20b_${randomBytes(4).toString('hex')}`;
  const admin = new Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const u = new URL(ADMIN);
  u.pathname = `/${name}`;
  const c = new Client({ connectionString: u.toString() });
  await c.connect();
  try {
    const old = mkdtempSync(join(tmpdir(), 'mig20b-'));
    for (const f of readdirSync(DIR).filter((x) => /^\d{4}_/.test(x) && x < '0020')) copyFileSync(join(DIR, f), join(old, f));
    await migrate(c, old);
    const us = await c.query(`INSERT INTO users (login, display_name, password_hash) VALUES ('dima','Дима','x'),('valya','Валя','x') RETURNING id`);
    const [dima, valya] = us.rows.map((r) => r.id);
    const b = (await c.query(`INSERT INTO blobs (sha256, path, mime, size_bytes) VALUES ($1,'b/1.jpg','image/jpeg',10) RETURNING id`, ['1'.padStart(64, '0')])).rows[0].id;
    const d = (await c.query(`INSERT INTO detections (blob_id, kind, x, y, w, h, score, model, vector) VALUES ($1,'face',0,0,.1,.1,.9,'m',$2) RETURNING id`, [b, Buffer.alloc(8)])).rows[0].id;
    const p1 = (await c.query("INSERT INTO people (owner_id, kind, name) VALUES ($1,'person','Мама') RETURNING id", [dima])).rows[0].id;
    const p2 = (await c.query("INSERT INTO people (owner_id, kind, name) VALUES ($1,'person','Бабушка') RETURNING id", [valya])).rows[0].id;
    await c.query("INSERT INTO detection_people (detection_id, owner_id, person_id, source) VALUES ($1,$2,$3,'auto'),($1,$4,$5,'manual')", [d, dima, p1, valya, p2]);
    await migrate(c, DIR);
    const r = (await c.query('SELECT person_id, source FROM detection_people WHERE detection_id = $1', [d])).rows;
    assert.deepEqual(r, [{ person_id: p2, source: 'manual' }]);
  } finally {
    await c.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
});
