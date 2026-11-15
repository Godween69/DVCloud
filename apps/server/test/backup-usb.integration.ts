// Копия на USB-диск и журнал: папка по дате, проверка, восстановление файлов и базы, удаление, команды диска. Настоящий Postgres, pg_dump, rsync.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, mkdir, writeFile, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { startEnv } from './helpers/filesenv';
import { mountOf } from '../src/files/backup.service';

describe('USB-диск и журнал копий (настоящий Postgres, pg_dump, pg_restore, rsync)', () => {
  const e = startEnv();
  let usb = '';
  let control = '';
  let hostSim: NodeJS.Timeout | null = null;
  const raw = (method: string, path: string, body?: unknown) =>
    fetch(e.intBase + path, { method, headers: { authorization: `Bearer ${e.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const j = async (method: string, path: string, body?: unknown) => { const r = await raw(method, path, body); return { status: r.status, json: (await r.json().catch(() => null)) as any }; };
  const waitDone = async () => {
    for (let i = 0; i < 300; i++) {
      const s = (await j('GET', '/internal/backup')).json;
      if (s.job && s.job.state !== 'running') return s.job;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('работа не закончилась');
  };
  const exists = async (p: string) => stat(p).then(() => true, () => false);
  const MARK = '.dvcloud-not-mounted';

  before(async () => {
    usb = await mkdtemp(join(tmpdir(), 'dvcloud-usb-'));
    control = await mkdtemp(join(tmpdir(), 'dvcloud-control-'));
    await writeFile(join(usb, MARK), ''); // диск пока не подключён
    await e.start({ DVCLOUD_USB_DIR: usb, DVCLOUD_CONTROL_DIR: control, DVCLOUD_BACKUP_DIR: join(usb, 'nonexistent') });
    for (const [n, who] of [['a.jpg', e.anna], ['b.jpg', e.boris]] as const) assert.equal((await e.upload(who, n, e.jpeg(n))).status, 201);
    // «Мини-ПК»: выполняет файлы-команды как скрипт хоста: подключить убирает метку, извлечь возвращает её
    hostSim = setInterval(async () => {
      for (const cmd of ['mount', 'eject']) {
        const f = join(control, `cmd-${cmd}`);
        if (!(await exists(f))) continue;
        if (cmd === 'mount') await rm(join(usb, MARK), { force: true });
        else await writeFile(join(usb, MARK), '');
        await writeFile(join(control, 'usb-result.json'), JSON.stringify({ cmd, ok: true, message: 'ok', at: new Date().toISOString() }));
        await rm(f, { force: true });
      }
    }, 50);
  });
  after(async () => {
    if (hostSim) clearInterval(hostSim);
    await e.stop();
    await rm(usb, { recursive: true, force: true });
    await rm(control, { recursive: true, force: true });
  });

  it('точка монтирования находится по mountinfo: самая длинная, пробелы в пути разбираются', () => {
    const info = [
      '22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw',
      '40 22 8:33 / /mnt/usb\\040disk rw,relatime shared:5 - ntfs3 /dev/sdc1 rw',
      '41 22 8:34 / /mnt rw,relatime - ext4 /dev/sdd1 rw',
    ].join('\n');
    assert.deepEqual(mountOf('/mnt/usb disk/Backup', info), { mountPoint: '/mnt/usb disk', fstype: 'ntfs3' });
    assert.deepEqual(mountOf('/mnt/other', info), { mountPoint: '/mnt', fstype: 'ext4' });
    assert.deepEqual(mountOf('/home/x', info), { mountPoint: '/', fstype: 'ext4' });
    assert.equal(mountOf('/x', 'мусор'), null);
  });

  it('диск не подключён: статус это показывает, копия не запускается, пишут понятно; команда «подключить» подключает', async () => {
    let s = (await j('GET', '/internal/backup')).json;
    assert.equal(s.usb.configured, true);
    assert.equal(s.usb.mounted, false);
    assert.equal(s.usb.canControl, true);
    assert.equal((await j('PATCH', '/internal/backup/config', { kind: 'usb' })).status, 200);
    const no = await j('POST', '/internal/backup/start');
    assert.equal(no.status, 400);
    assert.ok(/не подключён/.test(no.json.message), no.json.message);
    assert.equal((await j('POST', '/internal/backup/usb/zzz')).status, 400);
    assert.equal((await j('POST', '/internal/backup/usb/mount')).status, 200);
    s = (await j('GET', '/internal/backup')).json;
    assert.equal(s.usb.mounted, true);
    assert.ok(s.usb.freeBytes > 0 && s.usb.totalBytes >= s.usb.freeBytes);
    assert.match(s.plannedFolder, /^Backup_DVCloud_\d{2}\.\d{2}\.\d{4}$/);
  });

  it('копия на USB: папка с сегодняшней датой, запись в журнале, повтор в тот же день идёт в ту же папку', async () => {
    assert.equal((await j('POST', '/internal/backup/start')).status, 200);
    const job = await waitDone();
    assert.equal(job.state, 'done', JSON.stringify(job));
    assert.equal(job.action, 'backup');
    const s = (await j('GET', '/internal/backup')).json;
    const run = s.runs[0];
    assert.equal(run.kind, 'usb');
    assert.equal(run.state, 'done');
    assert.equal(run.folder, s.plannedFolder);
    assert.ok(run.dumpName && run.dbBytes > 0 && run.files >= 2);
    assert.equal(run.available, true);
    assert.equal(run.canManage, true);
    const dir = join(usb, run.folder);
    assert.ok((await readdir(join(dir, 'files', 'library'))).length >= 2, 'файлы на месте');
    assert.ok(await exists(join(dir, 'db', run.dumpName)), 'выгрузка базы на месте');
    assert.deepEqual((await readdir(usb)).filter((n) => n !== MARK && !n.startsWith('.write')), [run.folder], 'создана одна папка копии');
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal((await j('POST', '/internal/backup/start')).status, 200);
    assert.equal((await waitDone()).state, 'done');
    assert.equal((await readdir(usb)).filter((n) => n.startsWith('Backup_DVCloud_')).length, 1, 'в тот же день новая папка не создаётся');
    assert.equal((await j('GET', '/internal/backup')).json.runs.length, 2);
  });

  it('режимы папки: своё имя и «дописать в последнюю»; плохое имя отвергается', async () => {
    assert.equal((await j('PATCH', '/internal/backup/config', { folderMode: 'custom', folder: 'мои фото' })).status, 400);
    assert.equal((await j('PATCH', '/internal/backup/config', { folderMode: 'zzz' })).status, 400);
    assert.equal((await j('PATCH', '/internal/backup/config', { folderMode: 'custom', folder: 'Family 2026' })).status, 200);
    assert.equal((await j('GET', '/internal/backup')).json.plannedFolder, 'Family 2026');
    const first = (await j('GET', '/internal/backup')).json.runs.at(-1).folder;
    assert.equal((await j('PATCH', '/internal/backup/config', { folderMode: 'last' })).status, 200);
    assert.ok((await j('GET', '/internal/backup')).json.plannedFolder.startsWith('Backup_DVCloud_'));
    void first;
    assert.equal((await j('PATCH', '/internal/backup/config', { folderMode: 'new' })).status, 200);
  });

  it('проверка копии: в порядке; усечённый файл замечается; «новее копии» — не ошибка', async () => {
    const s0 = (await j('GET', '/internal/backup')).json;
    const run = s0.runs[0];
    assert.equal((await j('POST', `/internal/backup/runs/${run.id}/verify`)).status, 200);
    let job = await waitDone();
    assert.equal(job.action, 'verify');
    assert.equal(job.state, 'done', JSON.stringify(job));
    assert.match(job.note, /Копия в порядке/);
    assert.ok((await j('GET', '/internal/backup')).json.runs[0].verifiedAt);
    // новый файл появился после копии: «новее», не ошибка
    assert.equal((await e.upload(e.anna, 'c.jpg', e.jpeg('c.jpg'))).status, 201);
    await j('POST', `/internal/backup/runs/${run.id}/verify`);
    job = await waitDone();
    assert.equal(job.state, 'done');
    assert.match(job.note, /1 новее копии/);
    // порча: файл в копии укорочен
    const lib = join(usb, run.folder, 'files', 'library');
    const walk = async (d: string): Promise<string[]> => (await readdir(d, { withFileTypes: true })).flatMap((x) => (x.isDirectory() ? [] : [join(d, x.name)])).concat(...(await Promise.all((await readdir(d, { withFileTypes: true })).filter((x) => x.isDirectory()).map((x) => walk(join(d, x.name))))));
    const victim = (await walk(lib))[0];
    const orig = (await stat(victim)).size;
    await truncate(victim, 10);
    await j('POST', `/internal/backup/runs/${run.id}/verify`);
    job = await waitDone();
    assert.equal(job.state, 'error');
    assert.match(job.note, /1 файлов отличаются/);
    const v = (await j('GET', '/internal/backup')).json.runs[0].verify;
    assert.equal(v.differ, 1);
    // восстановление файлов: без слова-подтверждения нельзя; без перезаписи порча остаётся; с перезаписью чинится
    assert.equal((await j('POST', `/internal/backup/runs/${run.id}/restore-files`, { confirm: 'да' })).status, 400);
    // для проверки «возвращает недостающее»: стираем один файл в облаке
    const lost = join(e.dataDir, 'library', (await walk(lib))[1].slice(lib.length + 1)); // второй файл, который есть и в копии
    const lostSize = (await stat(lost)).size;
    await rm(lost);
    assert.equal((await j('POST', `/internal/backup/runs/${run.id}/restore-files`, { confirm: 'ВОССТАНОВИТЬ' })).status, 200);
    job = await waitDone();
    assert.equal(job.state, 'done', JSON.stringify(job));
    assert.equal((await stat(lost)).size, lostSize, 'недостающий файл вернулся');
    assert.equal((await stat(victim)).size, 10, 'без перезаписи испорченный файл в копии не трогался');
    // с перезаписью: берём файл из копии (он испорчен) — этим проверяем, что перезапись вообще включается; чиним копию вручную из облака
    await rm(victim);
    await writeFile(victim, Buffer.alloc(orig, 1));
    const cloudVictim = join(e.dataDir, 'library', victim.slice(lib.length + 1));
    await truncate(cloudVictim, 5); // в облаке тоже испорчено: перезапись должна вернуть из копии
    assert.equal((await j('POST', `/internal/backup/runs/${run.id}/restore-files`, { confirm: 'ВОССТАНОВИТЬ', overwrite: true })).status, 200);
    assert.equal((await waitDone()).state, 'done');
    assert.equal((await stat(cloudVictim)).size, orig, 'с перезаписью файл в облаке заменён файлом из копии');
  });

  it('восстановление базы: нужно слово-подтверждение; база возвращается к состоянию копии; журнал не затирается', async () => {
    const run = (await j('GET', '/internal/backup')).json.runs[0];
    // после копии меняем настройку, которая лежит в базе
    assert.equal((await j('PATCH', '/internal/backup/config', { limitMbit: 7 })).status, 200);
    assert.equal((await j('POST', `/internal/backup/runs/${run.id}/restore-db`, { confirm: 'ВОССТАНОВИТЬ' })).status, 400, 'нужна полная фраза');
    assert.equal((await j('POST', `/internal/backup/runs/${run.id}/restore-db`, { confirm: 'ВОССТАНОВИТЬ БАЗУ' })).status, 200);
    const job = await waitDone();
    assert.equal(job.state, 'done', JSON.stringify(job));
    assert.equal((await j('GET', '/internal/backup')).json.config.limitMbit, 0, 'настройка вернулась к состоянию копии');
    assert.ok((await readdir(join(usb, run.folder, 'db'))).some((n) => n.startsWith('before-restore-')), 'страховочная выгрузка лежит рядом');
    assert.ok((await j('GET', '/internal/backup')).json.runs.length >= 2, 'журнал копий не затёрт восстановлением');
    // другая версия базы: восстановление отказывает
    const c = new Client({ connectionString: e.dbUrl }); await c.connect();
    await c.query("UPDATE backup_runs SET migration = '0001_old.sql' WHERE id = $1", [run.id]); await c.end();
    const bad = await j('POST', `/internal/backup/runs/${run.id}/restore-db`, { confirm: 'ВОССТАНОВИТЬ БАЗУ' });
    assert.equal(bad.status, 400);
    assert.match(bad.json.message, /другой версией базы/);
  });

  it('удаление копии: нужно имя папки; папка стирается, запись уходит из журнала; чужие пути недоступны', async () => {
    const s = (await j('GET', '/internal/backup')).json;
    const run = s.runs[0];
    assert.equal((await j('POST', `/internal/backup/runs/${run.id}/delete`, { confirm: 'нет' })).status, 400);
    assert.equal((await j('POST', '/internal/backup/runs/99999/delete', { confirm: 'x' })).status, 404);
    assert.equal((await j('POST', '/internal/backup/runs/abc/verify')).status, 400);
    assert.equal((await j('POST', `/internal/backup/runs/${run.id}/forget`)).status, 400, 'пока папка на месте, из журнала не убрать');
    assert.equal((await j('POST', `/internal/backup/runs/${run.id}/delete`, { confirm: run.folder })).status, 200);
    const job = await waitDone();
    assert.equal(job.state, 'done', JSON.stringify(job));
    assert.equal(await exists(join(usb, run.folder)), false, 'папка копии стёрта');
    assert.ok(await exists(usb), 'сам диск цел');
    assert.equal((await j('GET', '/internal/backup')).json.runs.length, 0, 'обе записи этой папки ушли из журнала');
  });

  it('«Безопасно извлечь»: диск отключается, при идущей копии отказ; потом снова «подключить»', async () => {
    assert.equal((await j('POST', '/internal/backup/start')).status, 200);
    const busy = await j('POST', '/internal/backup/usb/eject');
    assert.ok(busy.status === 409 || busy.status === 200, 'если копия успела закончиться, извлечение проходит');
    await waitDone();
    assert.equal((await j('POST', '/internal/backup/usb/eject')).status, 200);
    assert.equal((await j('GET', '/internal/backup')).json.usb.mounted, false);
    assert.equal((await j('POST', '/internal/backup/start')).status, 400);
    assert.equal((await j('POST', '/internal/backup/usb/mount')).status, 200);
    assert.equal((await j('GET', '/internal/backup')).json.usb.mounted, true);
    void readFile;
  });

  it('места не хватает: копия не стартует и говорит, сколько нужно (папка новая)', async () => {
    const c = new Client({ connectionString: e.dbUrl }); await c.connect();
    await c.query("INSERT INTO blobs (sha256, path, mime, size_bytes) VALUES (repeat('f', 64), 'library/fake.bin', 'application/octet-stream', 900000000000000)");
    await c.end();
    await j('PATCH', '/internal/backup/config', { folderMode: 'custom', folder: 'Brand New' });
    const r = await j('POST', '/internal/backup/start');
    assert.equal(r.status, 400);
    assert.match(r.json.message, /Не хватит места/);
    await mkdir(join(usb, 'Brand New'), { recursive: true });
  });
});
