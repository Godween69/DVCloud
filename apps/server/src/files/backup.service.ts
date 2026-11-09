import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, statfs, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { Config } from '../config';
import { DbService } from '../db/db.service';
import { CONFIG } from '../tokens';

// Резервная копия облака: файлы (rsync) и выгрузка базы (pg_dump). Запускается только кнопкой в админке,
// идёт в фоне с низким приоритетом и ничего не меняет в самом облаке.
export interface BackupConfig {
  kind: 'folder' | 'ssh';
  folder: string; // kind=folder: подпапка внутри подключённого диска (может быть пустой)
  host: string; // kind=ssh
  port: number;
  user: string;
  path: string; // kind=ssh: папка на удалённом сервере
  withFiles: boolean; // копировать фото и видео
  withDb: boolean; // копировать выгрузку базы (люди, альбомы, группы, настройки)
  withTrash: boolean; // копировать и то, что лежит в корзинах (точная копия)
  withDerived: boolean; // копировать и производные файлы (миниатюры, превью, копии видео): они строятся заново, обычно не нужны
  mirror: boolean; // точная копия облака в папке files: нужна для восстановления
  readable: boolean; // ещё и «читаемая» копия по людям (папка people): смотреть без облака, но места занимает вдвое больше
  folders: 'none' | 'year' | 'month'; // читаемая копия: без подпапок, по годам или по годам и месяцам
  names: 'original' | 'date'; // читаемая копия: имя как есть или «2026-05-10_123000_имя»
  withAlbums: boolean; // читаемая копия: ещё и папки по альбомам (папка albums)
  limitMbit: number; // ограничение скорости, Мбит/с; 0 = без ограничения
}

export const DEFAULT_BACKUP: BackupConfig = { kind: 'folder', folder: '', host: '', port: 22, user: '', path: '', withFiles: true, withDb: true, withTrash: true, withDerived: false, mirror: true, readable: false, folders: 'year', names: 'original', withAlbums: false, limitMbit: 0 };

export interface BackupJob {
  state: 'running' | 'done' | 'error';
  step: string;
  percent: number | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  result: { files: number; bytes: number; dumpBytes: number; readable: number; pending: number; destination: string } | null;
}

export interface BackupStatus {
  config: BackupConfig;
  rootAvailable: boolean; // подключён ли диск для копий
  publicKey: string | null; // открытый ключ для kind=ssh (его нужно добавить на удалённый сервер)
  job: BackupJob | null;
  last: BackupJob | null; // последний завершённый запуск (переживает перезапуск сервера)
}

const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const RPATH_RE = /^[A-Za-z0-9._/~+@-]{1,200}$/;
const FOLDER_RE = /^[A-Za-z0-9._ -]{1,64}$/;
const DUMPS_KEEP = 7;

// Что не нужно копировать никогда: временные файлы и ключ для связи с удалённым сервером.
const ALWAYS_SKIP = ['/tmp/', '/uploads/', '/.backup-key/'];
const TRASH = ['/trash/'];
const DERIVED = ['/thumbs/', '/thumbs-fit/', '/previews/', '/videos/', '/faces/'];

export function parseBackupPatch(input: unknown): Partial<BackupConfig> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new BadRequestException('Ожидался объект с настройками копии');
  const out: Partial<BackupConfig> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (k === 'kind') {
      if (v !== 'folder' && v !== 'ssh') throw new BadRequestException('kind: folder или ssh');
      out.kind = v;
    } else if (k === 'folder') {
      if (typeof v !== 'string' || (v !== '' && (!FOLDER_RE.test(v) || v.startsWith('.') || v.startsWith('-')))) throw new BadRequestException('Папка: до 64 символов, буквы, цифры, пробел, точка, дефис; не с точки');
      out.folder = v;
    } else if (k === 'host') {
      if (typeof v !== 'string' || (v !== '' && !HOST_RE.test(v))) throw new BadRequestException('Сервер: адрес или имя, например 192.168.1.20 или backup.example.org');
      out.host = v;
    } else if (k === 'user') {
      if (typeof v !== 'string' || (v !== '' && !USER_RE.test(v))) throw new BadRequestException('Пользователь: маленькие латинские буквы, цифры, _ и -');
      out.user = v;
    } else if (k === 'path') {
      if (typeof v !== 'string' || (v !== '' && (!RPATH_RE.test(v) || v.includes('..') || v.startsWith('-')))) throw new BadRequestException('Папка на сервере: латиница, цифры и . _ / ~ + @ -, без пробелов и «..»');
      out.path = v;
    } else if (k === 'port') {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 65535) throw new BadRequestException('Порт: число от 1 до 65535');
      out.port = v;
    } else if (k === 'limitMbit') {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 10000) throw new BadRequestException('Скорость: число от 0 до 10000 (0 — без ограничения)');
      out.limitMbit = v;
    } else if (k === 'withFiles' || k === 'withDb' || k === 'withTrash' || k === 'withDerived' || k === 'mirror' || k === 'readable' || k === 'withAlbums') {
      if (typeof v !== 'boolean') throw new BadRequestException(`${k}: да или нет`);
      out[k] = v;
    } else if (k === 'folders') {
      if (v !== 'none' && v !== 'year' && v !== 'month') throw new BadRequestException('folders: none, year или month');
      out.folders = v;
    } else if (k === 'names') {
      if (v !== 'original' && v !== 'date') throw new BadRequestException('names: original или date');
      out.names = v;
    } else throw new BadRequestException(`Неизвестная настройка: ${k}`);
  }
  return out;
}

interface RunResult { code: number; out: string; err: string }

@Injectable()
export class BackupService {
  private job: BackupJob | null = null;

  constructor(
    @Inject(CONFIG) private readonly cfg: Config,
    @Inject(DbService) private readonly db: DbService,
  ) {}

  private get keyDir(): string { return resolve(this.cfg.dataDir, '.backup-key'); }
  private get keyFile(): string { return join(this.keyDir, 'id_ed25519'); }

  async getConfig(): Promise<BackupConfig> {
    const r = (await this.db.query<{ value: unknown }>("SELECT value FROM settings WHERE key = 'backup'")).rows[0];
    try {
      return { ...DEFAULT_BACKUP, ...parseBackupPatch(r?.value ?? {}) };
    } catch {
      return { ...DEFAULT_BACKUP };
    }
  }

  async saveConfig(patch: Partial<BackupConfig>): Promise<BackupConfig> {
    if (this.job?.state === 'running') throw new ConflictException('Идёт копирование: настройки можно менять после его конца');
    const next = { ...(await this.getConfig()), ...patch };
    await this.db.query(`INSERT INTO settings (key, value) VALUES ('backup', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(next)]);
    return next;
  }

  private async lastRun(): Promise<BackupJob | null> {
    const r = (await this.db.query<{ value: BackupJob }>("SELECT value FROM settings WHERE key = 'backup_last'")).rows[0];
    return r?.value ?? null;
  }

  private async rootAvailable(): Promise<boolean> {
    if (!this.cfg.backupDir) return false;
    try { return (await stat(this.cfg.backupDir)).isDirectory(); } catch { return false; }
  }

  // Открытый ключ создаётся один раз и лежит в каталоге данных (в копию не попадает).
  async publicKey(): Promise<string> {
    try {
      return (await readFile(`${this.keyFile}.pub`, 'utf8')).trim();
    } catch {
      await mkdir(this.keyDir, { recursive: true, mode: 0o700 });
      const r = await this.run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'dvcloud-backup', '-f', this.keyFile]);
      if (r.code !== 0) throw new BadRequestException('Не удалось создать ключ: в образе сервера нет ssh-keygen');
      return (await readFile(`${this.keyFile}.pub`, 'utf8')).trim();
    }
  }

  async status(): Promise<BackupStatus> {
    const config = await this.getConfig();
    let publicKey: string | null = null;
    if (config.kind === 'ssh') { try { publicKey = await this.publicKey(); } catch { publicKey = null; } }
    return { config, rootAvailable: await this.rootAvailable(), publicKey, job: this.job, last: await this.lastRun() };
  }

  // Подготовка места назначения: для папки проверка прав записи, для сервера проверка входа по ключу.
  // Возвращает человеческую строку «куда» и свободное место, если оно известно.
  async check(c: BackupConfig): Promise<{ where: string; freeBytes: number | null }> {
    if (c.kind === 'folder') {
      if (!(await this.rootAvailable())) throw new BadRequestException('Диск для копий не подключён к облаку. Подключите его на сервере (см. «Инфо» у способа «Диск или папка»)');
      const dir = this.folderPath(c);
      await mkdir(dir, { recursive: true });
      const probe = join(dir, `.write-test-${process.pid}`);
      try { await writeFile(probe, 'ok'); } catch { throw new BadRequestException('В эту папку нельзя записать: проверьте права на диске (хозяин папки — пользователь 1000)'); }
      await rm(probe, { force: true });
      const fs = await statfs(dir);
      return { where: dir, freeBytes: Number(fs.bavail) * Number(fs.bsize) };
    }
    this.needSsh(c);
    const r = await this.run('ssh', [...this.sshArgs(c), `${c.user}@${c.host}`, `mkdir -p ${c.path} && test -w ${c.path} && df -Pk ${c.path} | tail -1`], 20000);
    if (r.code !== 0) throw new BadRequestException(`Не удалось войти на сервер: ${this.tidy(r.err) || 'нет ответа'}. Проверьте адрес, пользователя и что открытый ключ добавлен на сервер`);
    const free = Number(r.out.trim().split(/\s+/)[3]);
    return { where: `${c.user}@${c.host}:${c.path}`, freeBytes: Number.isFinite(free) ? free * 1024 : null };
  }

  private needSsh(c: BackupConfig): void {
    if (!c.host || !c.user || !c.path) throw new BadRequestException('Заполните сервер, пользователя и папку на сервере');
  }

  private folderPath(c: BackupConfig): string {
    const root = resolve(this.cfg.backupDir);
    const dir = resolve(root, c.folder || '.', 'dvcloud-backup');
    if (dir !== root && !dir.startsWith(root + sep)) throw new BadRequestException('Папка вне диска для копий');
    return dir;
  }

  private sshArgs(c: BackupConfig): string[] {
    return ['-p', String(c.port), '-i', this.keyFile, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${join(this.keyDir, 'known_hosts')}`, '-o', 'ConnectTimeout=15'];
  }

  private tidy(s: string): string { return s.replace(/\s+/g, ' ').trim().slice(0, 300); }

  private run(cmd: string, args: string[], timeoutMs = 0, onChunk?: (s: string) => void, env?: NodeJS.ProcessEnv): Promise<RunResult> {
    return new Promise((resolveRun) => {
      let out = '';
      let err = '';
      let p;
      try {
        p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        return resolveRun({ code: 127, out: '', err: String(e) });
      }
      const timer = timeoutMs > 0 ? setTimeout(() => p.kill('SIGKILL'), timeoutMs) : null;
      p.stdout.on('data', (d: Buffer) => { const s = d.toString('utf8'); if (out.length < 4_000_000) out += s; onChunk?.(s); });
      p.stderr.on('data', (d: Buffer) => { if (err.length < 20000) err += d.toString('utf8'); });
      p.on('error', (e) => { if (timer) clearTimeout(timer); resolveRun({ code: 127, out, err: `${cmd}: ${e.message}` }); });
      p.on('close', (code) => { if (timer) clearTimeout(timer); resolveRun({ code: code ?? 1, out, err }); });
    });
  }

  // Запуск копирования. Отвечает сразу, ход виден в status().
  async start(): Promise<BackupJob> {
    if (this.job?.state === 'running') throw new ConflictException('Копирование уже идёт');
    const c = await this.getConfig();
    if (!c.withDb && !(c.withFiles && (c.mirror || c.readable))) throw new BadRequestException('Отметьте, что копировать: файлы (точная или читаемая копия) и/или базу данных');
    const where = await this.check(c);
    const job: BackupJob = { state: 'running', step: 'Подготовка', percent: null, startedAt: new Date().toISOString(), finishedAt: null, error: null, result: null };
    this.job = job;
    void this.execute(c, job, where.where).catch(() => undefined);
    return job;
  }

  private async execute(c: BackupConfig, job: BackupJob, where: string): Promise<void> {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
    const dumpName = `dvcloud-${stamp}.dump`;
    const tmpDump = resolve(this.cfg.dataDir, 'tmp', `backup-${dumpName}`);
    let stage = '';
    try {
      const target = c.kind === 'folder' ? this.folderPath(c) : `${c.user}@${c.host}:${c.path}`;
      const sep2 = target.endsWith('/') ? '' : '/';
      const rs = (extra: string[], skip: string[] = []) => ['-n', '19', 'rsync', '-a', '--mkpath', ...(c.kind === 'ssh' ? ['-e', ['ssh', ...this.sshArgs(c)].join(' ')] : []), ...(c.limitMbit > 0 ? [`--bwlimit=${c.limitMbit * 125}`] : []), ...skip.flatMap((d) => ['--exclude', d]), ...extra];
      let dumpBytes = 0;
      let files = 0;
      let bytes = 0;
      let readable = 0;
      let pending = 0;
      const num = (out: string, re: RegExp): number => Number((re.exec(out)?.[1] ?? '0').replace(/[,.\s]/g, ''));

      // 1. База: одним согласованным снимком (не мешает работе: читает, ничего не блокирует).
      if (c.withDb) {
        job.step = 'Выгружаю базу данных';
        const u = new URL(this.cfg.databaseUrl);
        await mkdir(dirname(tmpDump), { recursive: true });
        const dump = await this.run('nice', ['-n', '19', 'pg_dump', '-Fc', '-h', u.hostname, '-p', u.port || '5432', '-U', decodeURIComponent(u.username), '-d', u.pathname.slice(1), '-f', tmpDump], 0, undefined, { PGPASSWORD: decodeURIComponent(u.password) });
        if (dump.code !== 0) throw new Error(`Не удалось выгрузить базу: ${this.tidy(dump.err) || 'pg_dump не найден в образе сервера'}`);
        dumpBytes = (await stat(tmpDump)).size;
        job.step = 'Копирую базу данных';
        const put = await this.run('nice', rs([tmpDump, `${target}${sep2}db/${dumpName}`]));
        if (put.code !== 0) throw new Error(`Не удалось записать выгрузку базы: ${this.tidy(put.err) || `код ${put.code}`}`);
        await this.prune(c, target);
      }

      // 2. Точная копия файлов (для восстановления).
      const skip = [...ALWAYS_SKIP, ...(c.withTrash ? [] : TRASH), ...(c.withDerived ? [] : DERIVED)];
      const src = `${resolve(this.cfg.dataDir)}/`;
      if (c.withFiles && c.mirror) {
        job.step = 'Копирую файлы';
        job.percent = 0;
        const sync = await this.run('nice', rs(['--info=progress2,stats2', '--no-inc-recursive', src, `${target}${sep2}files/`], skip), 0, (s) => {
          const m = [...s.matchAll(/(\d{1,3})%/g)].pop();
          if (m) job.percent = Math.min(100, Number(m[1]));
        });
        if (sync.code !== 0 && sync.code !== 24) throw new Error(`Копирование файлов остановилось: ${this.tidy(sync.err) || `код ${sync.code}`}`);
        files = num(sync.out, /Number of regular files transferred: ([\d,.]+)/) || num(sync.out, /Number of files: [\d,.]+ \(reg: ([\d,.]+)/);
        bytes = num(sync.out, /Total file size: ([\d,.]+) bytes/);
        // Проверка: ещё один сухой проход должен найти, что ничего не отличается (по размеру). Новое, что люди загрузили за это время, не ошибка.
        job.step = 'Проверяю результат';
        job.percent = null;
        const ver = await this.run('nice', rs(['-n', '--size-only', '--itemize-changes', src, `${target}${sep2}files/`], skip));
        if (ver.code !== 0 && ver.code !== 24) throw new Error(`Проверка не получилась: ${this.tidy(ver.err) || `код ${ver.code}`}`);
        pending = ver.out.split('\n').filter((l) => /^>f/.test(l)).length;
      }

      // 3. Читаемая копия: люди, годы, понятные имена. Строится из ссылок во временной папке и копируется с их разыменованием.
      if (c.withFiles && c.readable) {
        job.step = 'Раскладываю файлы по людям';
        job.percent = null;
        stage = await mkdtemp(join(tmpdir(), 'dvcloud-readable-'));
        readable = await this.buildReadable(c, stage);
        job.step = 'Копирую читаемую копию';
        job.percent = 0;
        const rd = await this.run('nice', rs(['-L', '--info=progress2', '--no-inc-recursive', `${stage}/`, `${target}${sep2}`]), 0, (s) => {
          const m = [...s.matchAll(/(\d{1,3})%/g)].pop();
          if (m) job.percent = Math.min(100, Number(m[1]));
        });
        if (rd.code !== 0 && rd.code !== 24) throw new Error(`Копирование читаемой копии остановилось: ${this.tidy(rd.err) || `код ${rd.code}`}`);
      }

      job.result = { files, bytes, dumpBytes, readable, pending, destination: where };
      job.state = 'done';
      job.step = 'Готово';
      job.percent = 100;
    } catch (e) {
      job.state = 'error';
      job.error = e instanceof Error ? e.message : String(e);
      job.step = 'Остановлено';
    } finally {
      job.finishedAt = new Date().toISOString();
      await rm(tmpDump, { force: true }).catch(() => undefined);
      if (stage) await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      await this.db.query(`INSERT INTO settings (key, value) VALUES ('backup_last', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(job)]).catch(() => undefined);
    }
  }

  // Раскладка для читаемой копии: people/<логин>/<год>/<месяц>/<имя> и, по желанию, albums/<хозяин>/<альбом>/<имя>.
  // Файлы не копируются, а только связываются ссылками; одинаковые имена получают « (2)». Корзины не включаются.
  private async buildReadable(c: BackupConfig, stage: string): Promise<number> {
    const tz = (await this.db.query<{ tz: string | null }>("SELECT value->>'timezone' AS tz FROM settings WHERE key = 'media'")).rows[0]?.tz ?? 'UTC';
    const rows = (await this.db.query<{ id: string; login: string; name: string; path: string; y: string; m: string; stamp: string }>(
      `SELECT f.id, u.login, f.original_name AS name, b.path,
              to_char(f.taken_at AT TIME ZONE $1, 'YYYY') AS y, to_char(f.taken_at AT TIME ZONE $1, 'MM') AS m,
              to_char(f.taken_at AT TIME ZONE $1, 'YYYY-MM-DD_HH24MISS') AS stamp
         FROM files f JOIN users u ON u.id = f.owner_id JOIN blobs b ON b.id = f.blob_id
        WHERE f.trashed_at IS NULL ORDER BY f.taken_at, f.id`,
      [tz],
    )).rows;
    const used = new Set<string>();
    const link = async (dirRel: string, name: string, target: string): Promise<string> => {
      const dir = join(stage, dirRel);
      await mkdir(dir, { recursive: true });
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let n = 1;
      let cand = name;
      while (used.has(join(dirRel, cand))) cand = `${stem} (${++n})${ext}`;
      used.add(join(dirRel, cand));
      await symlink(target, join(dir, cand));
      return cand;
    };
    const safe = (x: string): string => x.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').trim().slice(0, 80) || '_';
    const where = new Map<string, { dir: string; name: string; abs: string; owner: string }>();
    let n = 0;
    for (const r of rows) {
      const sub = c.folders === 'none' ? '' : c.folders === 'year' ? r.y : join(r.y, r.m);
      const abs = resolve(this.cfg.dataDir, r.path);
      const name = await link(join('people', safe(r.login), sub), c.names === 'date' ? `${r.stamp}_${r.name}` : r.name, abs);
      where.set(r.id, { dir: join('people', safe(r.login), sub), name, abs, owner: r.login });
      n++;
    }
    if (c.withAlbums) {
      const al = (await this.db.query<{ file_id: string; album: string; owner: string }>(
        `SELECT ai.file_id, a.name AS album, u.login AS owner FROM album_items ai JOIN albums a ON a.id = ai.album_id JOIN users u ON u.id = a.owner_id JOIN files f ON f.id = ai.file_id WHERE f.trashed_at IS NULL ORDER BY a.id, ai.file_id`,
      )).rows;
      for (const x of al) {
        const w = where.get(x.file_id);
        if (w) await link(join('albums', safe(x.owner), safe(x.album)), w.name, w.abs);
      }
    }
    return n;
  }

  // Оставляет несколько последних выгрузок базы, старые стирает (только файлы dvcloud-*.dump в папке db).
  private async prune(c: BackupConfig, target: string): Promise<void> {
    if (c.kind === 'folder') {
      const dir = join(target, 'db');
      const names = (await readdir(dir)).filter((n) => /^dvcloud-\d{8}-\d{6}\.dump$/.test(n)).sort();
      for (const n of names.slice(0, Math.max(0, names.length - DUMPS_KEEP))) await rm(join(dir, n), { force: true });
      return;
    }
    const cmd = `cd ${c.path}/db && ls -1 | grep -E '^dvcloud-[0-9]{8}-[0-9]{6}\\.dump$' | sort | head -n -${DUMPS_KEEP} | xargs -r rm -f --`;
    await this.run('ssh', [...this.sshArgs(c), `${c.user}@${c.host}`, cmd], 30000);
  }
}
