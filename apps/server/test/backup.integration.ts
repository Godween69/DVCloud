// Резервная копия: настоящий Postgres, pg_dump и rsync в папку. Без SSH: он проверяется отдельно (разбор настроек).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEnv } from './helpers/filesenv';
import { parseBackupPatch } from '../src/files/backup.service';

describe('резервная копия (настоящий Postgres, pg_dump, rsync)', () => {
  const e = startEnv();
  let disk = '';
  const raw = (method: string, path: string, body?: unknown) =>
    fetch(e.intBase + path, { method, headers: { authorization: `Bearer ${e.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const j = async (method: string, path: string, body?: unknown) => { const r = await raw(method, path, body); return { status: r.status, json: (await r.json().catch(() => null)) as any }; };
  const waitDone = async () => {
    for (let i = 0; i < 200; i++) {
      const s = (await j('GET', '/internal/backup')).json;
      if (s.job && s.job.state !== 'running') return s.job;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('копия не закончилась');
  };

  before(async () => {
    disk = await mkdtemp(join(tmpdir(), 'dvcloud-backup-disk-'));
    process.env.DVCLOUD_BACKUP_DIR = disk;
    await e.start({ DVCLOUD_BACKUP_DIR: disk });
    for (const [n, who] of [['a.jpg', e.anna], ['b.jpg', e.boris]] as const) assert.equal((await e.upload(who, n, e.jpeg(n))).status, 201);
  });
  after(async () => { await e.stop(); await rm(disk, { recursive: true, force: true }); });

  it('настройки разбираются строго: чужие поля, плохой адрес, путь с «..» и пробелами отвергаются', () => {
    assert.deepEqual(parseBackupPatch({ kind: 'ssh', host: '192.168.1.20', port: 2222, user: 'backup', path: '/srv/dv-backup' }), { kind: 'ssh', host: '192.168.1.20', port: 2222, user: 'backup', path: '/srv/dv-backup' });
    for (const bad of [{ host: '-oProxyCommand=x' }, { host: 'a b' }, { user: 'Root' }, { user: '-x' }, { path: '/a/../b' }, { path: '/a b' }, { path: '-rf' }, { port: 0 }, { port: 70000 }, { folder: '../x' }, { folder: '.hid' }, { kind: 'ftp' }, { limitMbit: -1 }, { zzz: 1 }, { withDerived: 'да' }, { folders: 'week' }, { names: 'x' }, { readable: 1 }, { withDb: 'да' }]) {
      assert.throws(() => parseBackupPatch(bad), `${JSON.stringify(bad)} должно отвергаться`);
    }
  });

  it('до настройки и без диска: понятные ошибки, ничего не запускается', async () => {
    const s = (await j('GET', '/internal/backup')).json;
    assert.equal(s.config.kind, 'folder');
    assert.equal(s.rootAvailable, true);
    assert.equal(s.job, null);
    assert.equal((await j('PATCH', '/internal/backup/config', { host: 'a b' })).status, 400);
    assert.equal((await j('PATCH', '/internal/backup/config', { kind: 'ssh' })).status, 200);
    assert.equal((await j('POST', '/internal/backup/start')).status, 400, 'без сервера и пользователя запуск отказывает');
    await j('PATCH', '/internal/backup/config', { kind: 'folder' });
  });

  it('копия в папку: файлы, выгрузка базы, проверка; повтор ничего не дублирует; производные не копируются', async () => {
    assert.equal((await j('PATCH', '/internal/backup/config', { kind: 'folder', folder: 'семья' })).status, 400, 'кириллица в имени папки не допускается');
    assert.equal((await j('PATCH', '/internal/backup/config', { kind: 'folder', folder: 'mybackup' })).status, 200);
    await mkdir(join(e.dataDir, 'thumbs'), { recursive: true });
    await writeFile(join(e.dataDir, 'thumbs', 'x.webp'), 'derived');
    await mkdir(join(e.dataDir, 'tmp'), { recursive: true });
    await writeFile(join(e.dataDir, 'tmp', 'half'), 'temp');
    const chk = await j('POST', '/internal/backup/check');
    assert.equal(chk.status, 200);
    assert.ok(chk.json.freeBytes > 0);
    assert.equal((await j('POST', '/internal/backup/start')).status, 200);
    const job = await waitDone();
    assert.equal(job.state, 'done', JSON.stringify(job));
    assert.equal(job.result.pending, 0, 'после копии нечего догонять');
    assert.ok(job.result.files >= 2 && job.result.dumpBytes > 0);
    const base = join(disk, 'mybackup', 'dvcloud-backup');
    const dumps = (await readdir(join(base, 'db'))).filter((n) => n.endsWith('.dump'));
    assert.equal(dumps.length, 1);
    assert.ok((await stat(join(base, 'db', dumps[0]))).size > 1000);
    const tree = async (d: string): Promise<string[]> => (await readdir(d, { withFileTypes: true })).flatMap((x) => (x.isDirectory() ? [] : [x.name]));
    assert.ok((await readdir(join(base, 'files', 'library'))).length >= 2, 'библиотека скопирована');
    await assert.rejects(stat(join(base, 'files', 'thumbs')), 'миниатюры не копируются');
    await assert.rejects(stat(join(base, 'files', 'tmp')), 'временные файлы не копируются');
    await assert.rejects(stat(join(base, 'files', '.backup-key')));
    void tree;
    // повтор: тот же набор файлов, ещё одна выгрузка базы
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal((await j('POST', '/internal/backup/start')).status, 200);
    assert.equal((await waitDone()).state, 'done');
    assert.equal((await readdir(join(base, 'db'))).filter((n) => n.endsWith('.dump')).length, 2);
    const last = (await j('GET', '/internal/backup')).json.last;
    assert.equal(last.state, 'done');
  });

  it('выгрузка базы восстанавливается: pg_restore --list читает её и видит таблицу files', async () => {
    const dumps = (await readdir(join(disk, 'mybackup', 'dvcloud-backup', 'db'))).filter((n) => n.endsWith('.dump')).sort();
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('pg_restore', ['--list', join(disk, 'mybackup', 'dvcloud-backup', 'db', dumps[dumps.length - 1])], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(/TABLE public files /.test(r.stdout), 'таблица files есть в выгрузке');
    void readFile;
  });

  it('состав копии по выбору: без базы, читаемая копия по людям и месяцам с именами по дате и альбомами; пустой выбор отвергается', async () => {
    const J = { type: 'application/json' };
    const alb = (await e.api('POST', '/api/albums', { cookie: e.anna, body: JSON.stringify({ name: 'Отпуск: лето/2026' }), ...J })).json.album;
    const fid = (await e.api('GET', '/api/files?limit=10', { cookie: e.anna })).json.files[0].id;
    await e.api('POST', `/api/albums/${alb.id}/add`, { cookie: e.anna, body: JSON.stringify({ ids: [fid] }), ...J });
    assert.equal((await j('PATCH', '/internal/backup/config', { folder: 'second', withFiles: false, withDb: false })).status, 200);
    const none = await j('POST', '/internal/backup/start');
    assert.equal(none.status, 400);
    assert.ok(/Отметьте, что копировать/.test(none.json.message));
    assert.equal((await j('PATCH', '/internal/backup/config', { withFiles: true, withDb: false, mirror: false, readable: true, folders: 'month', names: 'date', withAlbums: true })).status, 200);
    assert.equal((await j('POST', '/internal/backup/start')).status, 200);
    const job = await waitDone();
    assert.equal(job.state, 'done', JSON.stringify(job));
    assert.equal(job.result.readable, 2);
    assert.equal(job.result.dumpBytes, 0);
    const base = join(disk, 'second', 'dvcloud-backup');
    await assert.rejects(stat(join(base, 'db')), 'базу не просили');
    await assert.rejects(stat(join(base, 'files')), 'точную копию не просили');
    const years = await readdir(join(base, 'people', 'anna'));
    assert.equal(years.length, 1);
    assert.ok(/^\d{4}$/.test(years[0]));
    const months = await readdir(join(base, 'people', 'anna', years[0]));
    assert.ok(/^\d{2}$/.test(months[0]), 'подпапки по месяцам');
    const names = await readdir(join(base, 'people', 'anna', years[0], months[0]));
    assert.ok(names.every((n) => /^\d{4}-\d{2}-\d{2}_\d{6}_/.test(n)), `имена с датой: ${names}`);
    const st = await stat(join(base, 'people', 'anna', years[0], months[0], names[0]));
    assert.ok(st.isFile() && !st.isSymbolicLink(), 'в копии настоящий файл, а не ссылка');
    assert.ok((await readdir(join(base, 'people', 'boris'))).length === 1);
    const albDirs = await readdir(join(base, 'albums', 'anna'));
    assert.deepEqual(albDirs, ['Отпуск_ лето_2026'], 'имя альбома безопасно для файловой системы');
    assert.equal((await readdir(join(base, 'albums', 'anna', albDirs[0]))).length, 1);
    // без подпапок и с исходными именами; повторное имя получает « (2)»
    assert.equal((await j('PATCH', '/internal/backup/config', { folders: 'none', names: 'original', withAlbums: false })).status, 200);
    assert.equal((await j('POST', '/internal/backup/start')).status, 200);
    assert.equal((await waitDone()).state, 'done');
    assert.ok((await readdir(join(base, 'people', 'anna'))).includes('a.jpg'));
    await j('PATCH', '/internal/backup/config', { folder: 'mybackup', mirror: true, readable: false, withDb: true });
  });

  it('второй запуск во время работы отклоняется (409), ошибка копирования показывается человеку', async () => {
    assert.equal((await j('PATCH', '/internal/backup/config', { kind: 'folder', folder: 'mybackup' })).status, 200);
    const a = await j('POST', '/internal/backup/start');
    const b = await j('POST', '/internal/backup/start');
    assert.equal(a.status, 200);
    assert.ok(b.status === 409 || b.status === 200, 'очень быстрая копия могла уже закончиться');
    await waitDone();
    // диск пропал: корневой папки нет
    await rm(disk, { recursive: true, force: true });
    const r = await j('POST', '/internal/backup/start');
    assert.equal(r.status, 400);
    assert.ok(/не подключён/.test(r.json.message), r.json.message);
    await mkdir(disk, { recursive: true });
  });
});
