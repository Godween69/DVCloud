import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, statfs, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { Config } from '../config';
import { DbService } from '../db/db.service';
import { CONFIG } from '../tokens';

// Резервная копия облака: файлы (rsync) и выгрузка базы (pg_dump). Запускается только кнопкой в админке,
// идёт в фоне с низким приоритетом и ничего не меняет в самом облаке.
export interface BackupConfig {
  kind: 'folder' | 'ssh' | 'usb';
  folder: string; // kind=folder: подпапка внутри подключённого диска (может быть пустой); kind=usb: своё имя папки копии (при folderMode=custom)
  folderMode: 'new' | 'last' | 'custom'; // kind=usb: новая папка Backup_DVCloud_<дата> / дописать в последнюю копию / своё имя
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

interface Plan { target: string; rel: string; root: string | null } // куда пойдёт эта копия

export const DEFAULT_BACKUP: BackupConfig = { kind: 'folder', folder: '', folderMode: 'new', host: '', port: 22, user: '', path: '', withFiles: true, withDb: true, withTrash: true, withDerived: false, mirror: true, readable: false, folders: 'year', names: 'original', withAlbums: false, limitMbit: 0 };

export type BackupAction = 'backup' | 'verify' | 'delete' | 'restore-files' | 'restore-db';

export interface BackupJob {
  action: BackupAction; // что идёт: копирование, проверка копии, удаление копии, восстановление файлов или базы
  runId: number | null; // запись журнала, с которой работает действие (для копирования это новая запись)
  note: string | null; // итог не-копирования одной строкой (например, «проверка: расхождений нет»)
  state: 'running' | 'done' | 'error';
  step: string;
  percent: number | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  result: { files: number; bytes: number; dumpBytes: number; readable: number; pending: number; destination: string } | null;
}

export interface UsbStatus {
  configured: boolean; // папка для USB-диска проброшена в контейнер
  mounted: boolean; // диск сейчас подключён к мини-ПК и виден облаку
  fstype: string | null;
  totalBytes: number | null;
  freeBytes: number | null;
  canControl: boolean; // есть канал команд хосту: можно подключить и безопасно извлечь диск из админки
  lastCommand: { cmd: string; ok: boolean; message: string; at: string } | null;
}

export interface VerifyResult { dumpOk: boolean | null; dumpName: string | null; newer: number; differ: number; filesChecked: boolean }

export interface BackupRun {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  kind: 'folder' | 'usb' | 'ssh';
  state: 'running' | 'done' | 'error';
  folder: string;
  destination: string;
  files: number | null;
  bytes: number | null;
  dbBytes: number | null;
  error: string | null;
  dumpName: string | null;
  migration: string | null;
  verifiedAt: string | null;
  verify: VerifyResult | null;
  available: boolean | null; // папка копии на месте (для копии на другом сервере неизвестно)
  canManage: boolean; // проверка, восстановление и удаление из админки доступны (не для копии по SSH)
  withDb: boolean;
  withFiles: boolean;
}

export interface BackupStatus {
  config: BackupConfig;
  rootAvailable: boolean; // подключён ли диск для копий
  usb: UsbStatus;
  runs: BackupRun[]; // журнал копий, новые сверху
  needBytes: number; // сколько примерно займёт полная копия файлов (по базе), чтобы показать «влезет или нет»
  plannedFolder: string | null; // имя папки, в которую ляжет следующая копия на USB-диск
  newFolder: string; // как называлась бы новая папка копии сегодня (Backup_DVCloud_дата)
  publicKey: string | null; // открытый ключ для kind=ssh (его нужно добавить на удалённый сервер)
  job: BackupJob | null;
  last: BackupJob | null; // последний завершённый запуск (переживает перезапуск сервера)
}

const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const RPATH_RE = /^[A-Za-z0-9._/~+@-]{1,200}$/;
const FOLDER_RE = /^[A-Za-z0-9._ -]{1,64}$/;
const DUMPS_KEEP = 7;
const LITE_FS = new Set(['ntfs', 'ntfs3', 'fuseblk', 'vfat', 'exfat', 'msdos', 'cifs', 'smb3']); // файловые системы без прав и владельцев Unix
const NOT_MOUNTED_MARK = '.dvcloud-not-mounted'; // файл-метка в пустой папке на мини-ПК: пока диск не подключён, он виден; подключённый диск закрывает его
const CONFIRM_RESTORE = 'ВОССТАНОВИТЬ';
const CONFIRM_RESTORE_DB = 'ВОССТАНОВИТЬ БАЗУ';

// Что смонтировано по пути: самая длинная точка монтирования из /proc/self/mountinfo.
export function mountOf(path: string, info: string): { mountPoint: string; fstype: string } | null {
  let best: { mountPoint: string; fstype: string } | null = null;
  for (const line of info.split('\n')) {
    const at = line.indexOf(' - ');
    if (at < 0) continue;
    const left = line.slice(0, at).split(' ');
    const right = line.slice(at + 3).split(' ');
    const mp = (left[4] ?? '').replace(/\\([0-7]{3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8)));
    if (!mp) continue;
    if (path === mp || path.startsWith(mp.endsWith('/') ? mp : `${mp}/`)) {
      if (!best || mp.length >= best.mountPoint.length) best = { mountPoint: mp, fstype: right[0] ?? '' };
    }
  }
  return best;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const exists = async (p: string): Promise<boolean> => { try { await stat(p); return true; } catch { return false; } };

// Что не нужно копировать никогда: временные файлы и ключ для связи с удалённым сервером.
const ALWAYS_SKIP = ['/tmp/', '/uploads/', '/.backup-key/'];
const TRASH = ['/trash/'];
const DERIVED = ['/thumbs/', '/thumbs-fit/', '/previews/', '/videos/', '/faces/'];

export function parseBackupPatch(input: unknown): Partial<BackupConfig> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new BadRequestException('Ожидался объект с настройками копии');
  const out: Partial<BackupConfig> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (k === 'kind') {
      if (v !== 'folder' && v !== 'ssh' && v !== 'usb') throw new BadRequestException('kind: folder, usb или ssh');
      out.kind = v;
    } else if (k === 'folderMode') {
      if (v !== 'new' && v !== 'last' && v !== 'custom') throw new BadRequestException('folderMode: new, last или custom');
      out.folderMode = v;
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
export class BackupService implements OnModuleInit {
  private job: BackupJob | null = null;
  private proc: ChildProcess | null = null; // текущая внешняя команда копирования (rsync, pg_dump): её останавливает кнопка «Остановить»
  private stopRequested = false;

  constructor(
    @Inject(CONFIG) private readonly cfg: Config,
    @Inject(DbService) private readonly db: DbService,
  ) {}

  // После перезапуска сервера «идущие» записи журнала уже никуда не идут: помечаем их прерванными.
  async onModuleInit(): Promise<void> {
    await this.db.query("UPDATE backup_runs SET state = 'error', finished_at = now(), error = 'Прервано перезапуском сервера' WHERE state = 'running'").catch(() => undefined);
  }

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
    const usb = await this.usbStatus();
    return { config, rootAvailable: await this.rootAvailable(), usb, runs: await this.runs(), needBytes: await this.needBytes(), plannedFolder: config.kind === 'usb' && usb.configured ? await this.usbFolder(config) : null, newFolder: `Backup_DVCloud_${await this.todayName()}`, publicKey, job: this.job, last: await this.lastRun() };
  }

  // Подготовка места назначения: для папки проверка прав записи, для сервера проверка входа по ключу.
  // Возвращает человеческую строку «куда» и свободное место, если оно известно.
  async check(c: BackupConfig): Promise<{ where: string; freeBytes: number | null }> {
    if (c.kind === 'usb') {
      const u = await this.usbStatus();
      if (!u.configured) throw new BadRequestException('USB-диск не настроен на сервере: папка для него не проброшена в облако (роль minipc_dvcloud)');
      if (!u.mounted) throw new BadRequestException('USB-диск не подключён. Воткните его в мини-ПК; если он уже воткнут, нажмите «Подключить диск». Если не подключается, проверьте диск в Windows (chkdsk): возможно, его вынули без безопасного извлечения');
      const probe = join(this.usbDir, `.write-test-${process.pid}`);
      try { await writeFile(probe, 'ok'); } catch { throw new BadRequestException('На USB-диск нельзя записать: он подключён только для чтения (возможно, требует проверки в Windows) или защищён от записи'); }
      await rm(probe, { force: true });
      return { where: (await this.plan(c)).target, freeBytes: u.freeBytes };
    }
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

  private get usbDir(): string { return this.cfg.usbDir ? resolve(this.cfg.usbDir) : ''; }

  // Дата для имени папки: сегодняшняя по часовому поясу облака, вида 10.11.2026.
  private async todayName(): Promise<string> {
    const tz = (await this.db.query<{ tz: string | null }>("SELECT value->>'timezone' AS tz FROM settings WHERE key = 'media'")).rows[0]?.tz ?? 'UTC';
    const fmt = (zone: string): string => new Intl.DateTimeFormat('ru-RU', { timeZone: zone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date());
    try { return fmt(tz); } catch { return fmt('UTC'); }
  }

  // Имя папки копии на USB-диске: новая «Backup_DVCloud_<сегодня>», дописать в последнюю или своё имя.
  private async usbFolder(c: BackupConfig): Promise<string> {
    if (c.folderMode === 'custom' && c.folder) return c.folder;
    if (c.folderMode === 'last') {
      const r = (await this.db.query<{ folder: string }>("SELECT folder FROM backup_runs WHERE kind = 'usb' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1")).rows[0];
      if (r && this.usbDir && (await exists(resolve(this.usbDir, r.folder)))) return r.folder;
    }
    return `Backup_DVCloud_${await this.todayName()}`;
  }

  private async plan(c: BackupConfig): Promise<Plan> {
    if (c.kind === 'ssh') return { target: `${c.user}@${c.host}:${c.path}`, rel: '', root: null };
    if (c.kind === 'usb') {
      const name = await this.usbFolder(c);
      return { target: resolve(this.usbDir, name), rel: name, root: this.usbDir };
    }
    const dir = this.folderPath(c);
    return { target: dir, rel: basename(dirname(dir)) === basename(resolve(this.cfg.backupDir)) ? 'dvcloud-backup' : `${basename(dirname(dir))}/dvcloud-backup`, root: resolve(this.cfg.backupDir) };
  }

  // Файловая система без прав и владельцев Unix (NTFS, FAT, сетевые): rsync -a там сыплет ошибками «Operation not permitted».
  private async liteFs(c: BackupConfig, root: string | null): Promise<boolean> {
    if (c.kind === 'usb') return true;
    if (!root) return false;
    try { const m = mountOf(root, await readFile('/proc/self/mountinfo', 'utf8')); return !!m && LITE_FS.has(m.fstype); } catch { return false; }
  }

  // Сколько примерно занимают оригиналы (по базе): чтобы заранее сказать «влезет или нет».
  private async needBytes(): Promise<number> {
    const r = (await this.db.query<{ n: string }>('SELECT COALESCE(sum(size_bytes), 0)::text AS n FROM blobs')).rows[0];
    return Number(r?.n ?? 0);
  }

  private human(n: number): string {
    const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
    let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
  }

  // ===== USB-диск: состояние и команды хосту =====
  private async controlOk(): Promise<boolean> {
    if (!this.cfg.controlDir) return false;
    try { return (await stat(this.cfg.controlDir)).isDirectory(); } catch { return false; }
  }

  // Подключён ли диск: пока он не подключён, в пустой папке на мини-ПК лежит файл-метка, подключённый диск её закрывает.
  async usbMounted(): Promise<boolean> {
    if (!this.usbDir) return false;
    try { if (!(await stat(this.usbDir)).isDirectory()) return false; } catch { return false; }
    return !(await exists(join(this.usbDir, NOT_MOUNTED_MARK)));
  }

  async usbStatus(): Promise<UsbStatus> {
    const configured = !!this.usbDir;
    const mounted = await this.usbMounted();
    let fstype: string | null = null;
    let totalBytes: number | null = null;
    let freeBytes: number | null = null;
    if (mounted) {
      try { const fs = await statfs(this.usbDir); totalBytes = Number(fs.blocks) * Number(fs.bsize); freeBytes = Number(fs.bavail) * Number(fs.bsize); } catch { /* нет данных */ }
      try { fstype = mountOf(this.usbDir, await readFile('/proc/self/mountinfo', 'utf8'))?.fstype ?? null; } catch { /* нет данных */ }
    }
    let lastCommand: UsbStatus['lastCommand'] = null;
    if (this.cfg.controlDir) { try { lastCommand = JSON.parse(await readFile(join(this.cfg.controlDir, 'usb-result.json'), 'utf8')) as UsbStatus['lastCommand']; } catch { /* ещё не было команд */ } }
    return { configured, mounted, fstype, totalBytes, freeBytes, canControl: await this.controlOk(), lastCommand };
  }

  // Команда хосту: «подключить» или «безопасно извлечь». Контейнер не может сам монтировать, поэтому кладёт файл-команду,
  // а мини-ПК (юнит dvcloud-usb.path) выполняет её и пишет итог в usb-result.json.
  async usbCommand(cmd: 'mount' | 'eject'): Promise<UsbStatus> {
    if (!(await this.controlOk())) throw new BadRequestException('Управление диском не настроено на мини-ПК (роль minipc_dvcloud)');
    if (cmd === 'eject' && this.job?.state === 'running') throw new ConflictException('Идёт работа с копиями: дождитесь конца или остановите её, потом извлекайте диск');
    const file = join(this.cfg.controlDir, `cmd-${cmd}`);
    await writeFile(file, new Date().toISOString());
    for (let i = 0; i < 80 && (await exists(file)); i++) await sleep(250);
    if (await exists(file)) { await rm(file, { force: true }); throw new BadRequestException('Мини-ПК не ответил на команду за 20 секунд: проверьте службу dvcloud-usb.path на мини-ПК'); }
    const st = await this.usbStatus();
    if (st.lastCommand && st.lastCommand.cmd === cmd && !st.lastCommand.ok) throw new BadRequestException(st.lastCommand.message || 'Команда не выполнилась');
    return st;
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
      this.proc = p;
      const timer = timeoutMs > 0 ? setTimeout(() => p.kill('SIGKILL'), timeoutMs) : null;
      p.stdout.on('data', (d: Buffer) => { const s = d.toString('utf8'); if (out.length < 4_000_000) out += s; onChunk?.(s); });
      p.stderr.on('data', (d: Buffer) => { if (err.length < 20000) err += d.toString('utf8'); });
      p.on('error', (e) => { if (timer) clearTimeout(timer); resolveRun({ code: 127, out, err: `${cmd}: ${e.message}` }); });
      p.on('close', (code) => { if (timer) clearTimeout(timer); if (this.proc === p) this.proc = null; resolveRun({ code: code ?? 1, out, err }); });
    });
  }

  // Запуск копирования. Отвечает сразу, ход виден в status().
  async start(): Promise<BackupJob> {
    if (this.job?.state === 'running') throw new ConflictException('Копирование уже идёт');
    const c = await this.getConfig();
    if (!c.withDb && !(c.withFiles && (c.mirror || c.readable))) throw new BadRequestException('Отметьте, что копировать: файлы (точная или читаемая копия) и/или базу данных');
    const where = await this.check(c);
    const plan = await this.plan(c);
    if (c.kind !== 'ssh' && c.withFiles && c.mirror && where.freeBytes !== null && !(await this.nonEmptyDir(plan.target))) {
      const need = await this.needBytes();
      if (need * 1.02 > where.freeBytes) throw new BadRequestException(`Не хватит места: копия файлов займёт около ${this.human(need)}, на диске свободно ${this.human(where.freeBytes)}`);
    }
    this.stopRequested = false;
    const runId = await this.journalStart(c, plan);
    const job: BackupJob = { action: 'backup', runId, note: null, state: 'running', step: 'Подготовка', percent: null, startedAt: new Date().toISOString(), finishedAt: null, error: null, result: null };
    this.job = job;
    void this.execute(c, job, plan, runId).catch(() => undefined);
    return job;
  }

  // Остановка идущего копирования: прерывает rsync или pg_dump. Уже скопированное остаётся, следующая копия продолжит с этого места.
  async cancel(): Promise<BackupJob> {
    if (this.job?.state !== 'running') throw new ConflictException('Сейчас ничего не идёт');
    this.stopRequested = true;
    this.job.step = 'Останавливаю';
    this.proc?.kill('SIGTERM');
    return this.job;
  }

  private async nonEmptyDir(dir: string): Promise<boolean> {
    try { return (await readdir(dir)).length > 0; } catch { return false; }
  }

  private async execute(c: BackupConfig, job: BackupJob, plan: Plan, runId: number): Promise<void> {
    const where = plan.target;
    let dumpUsed: string | null = null;
    const stopIf = (): void => { if (this.stopRequested) throw new Error('Копирование остановлено вами'); };
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
    const dumpName = `dvcloud-${stamp}.dump`;
    const tmpDump = resolve(this.cfg.dataDir, 'tmp', `backup-${dumpName}`);
    let stage = '';
    try {
      const target = plan.target;
      const sep2 = target.endsWith('/') ? '' : '/';
      const lite = await this.liteFs(c, plan.root);
      const rs = (extra: string[], skip: string[] = []) => ['-n', '19', 'rsync', ...(lite ? ['-rt', '--no-perms', '--no-owner', '--no-group', '--modify-window=2'] : ['-a']), '--mkpath', ...(c.kind === 'ssh' ? ['-e', ['ssh', ...this.sshArgs(c)].join(' ')] : []), ...(c.limitMbit > 0 ? [`--bwlimit=${c.limitMbit * 125}`] : []), ...skip.flatMap((d) => ['--exclude', d]), ...extra];
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
        const dump = await this.run('nice', ['-n', '19', 'pg_dump', '-Fc', '--exclude-table=backup_runs', '--exclude-table=backup_runs_id_seq', '-h', u.hostname, '-p', u.port || '5432', '-U', decodeURIComponent(u.username), '-d', u.pathname.slice(1), '-f', tmpDump], 0, undefined, { PGPASSWORD: decodeURIComponent(u.password) });
        stopIf();
        if (dump.code !== 0) throw new Error(`Не удалось выгрузить базу: ${this.tidy(dump.err) || 'pg_dump не найден в образе сервера'}`);
        dumpBytes = (await stat(tmpDump)).size;
        job.step = 'Копирую базу данных';
        dumpUsed = dumpName;
        const put = await this.run('nice', rs([tmpDump, `${target}${sep2}db/${dumpName}`]));
        stopIf();
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
        stopIf();
        if (sync.code !== 0 && sync.code !== 24) throw new Error(`Копирование файлов остановилось: ${this.tidy(sync.err) || `код ${sync.code}`}`);
        files = num(sync.out, /Number of regular files transferred: ([\d,.]+)/) || num(sync.out, /Number of files: [\d,.]+ \(reg: ([\d,.]+)/);
        bytes = num(sync.out, /Total file size: ([\d,.]+) bytes/);
        // Проверка: ещё один сухой проход должен найти, что ничего не отличается (по размеру). Новое, что люди загрузили за это время, не ошибка.
        job.step = 'Проверяю результат';
        job.percent = null;
        const ver = await this.run('nice', rs(['-n', '--size-only', '--itemize-changes', src, `${target}${sep2}files/`], skip));
        stopIf();
        if (ver.code !== 0 && ver.code !== 24) throw new Error(`Проверка не получилась: ${this.tidy(ver.err) || `код ${ver.code}`}`);
        pending = ver.out.split('\n').filter((l) => /^>f/.test(l)).length;
      }

      // 3. Читаемая копия: люди, годы, понятные имена. Строится из ссылок во временной папке и копируется с их разыменованием.
      if (c.withFiles && c.readable) {
        job.step = 'Раскладываю файлы по людям';
        job.percent = null;
        stage = await mkdtemp(join(tmpdir(), 'dvcloud-readable-'));
        readable = await this.buildReadable(c, stage);
        stopIf();
        job.step = 'Копирую читаемую копию';
        job.percent = 0;
        const rd = await this.run('nice', rs(['-L', '--info=progress2', '--no-inc-recursive', `${stage}/`, `${target}${sep2}`]), 0, (s) => {
          const m = [...s.matchAll(/(\d{1,3})%/g)].pop();
          if (m) job.percent = Math.min(100, Number(m[1]));
        });
        stopIf();
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
      await this.journalFinish(runId, job, dumpUsed).catch(() => undefined);
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

  // ===== Журнал копий =====
  private async journalStart(c: BackupConfig, plan: Plan): Promise<number> {
    const mig = (await this.db.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1')).rows[0]?.name ?? null;
    const r = await this.db.query<{ id: string }>(
      `INSERT INTO backup_runs (kind, state, folder, destination, config, migration) VALUES ($1, 'running', $2, $3, $4::jsonb, $5) RETURNING id`,
      [c.kind, plan.rel, plan.target, JSON.stringify(c), mig],
    );
    return Number(r.rows[0].id);
  }

  private async journalFinish(runId: number, job: BackupJob, dumpName: string | null): Promise<void> {
    await this.db.query(
      `UPDATE backup_runs SET state = $2, finished_at = now(), files = $3, bytes = $4, db_bytes = $5, error = $6, dump_name = $7 WHERE id = $1`,
      [runId, job.state, job.result?.files ?? null, job.result?.bytes ?? null, job.result?.dumpBytes ?? null, job.error, dumpName],
    );
  }

  async runs(): Promise<BackupRun[]> {
    const rows = (await this.db.query<{
      id: string; started_at: Date; finished_at: Date | null; kind: BackupRun['kind']; state: BackupRun['state']; folder: string; destination: string;
      files: number | null; bytes: string | null; db_bytes: string | null; error: string | null; dump_name: string | null; migration: string | null;
      verified_at: Date | null; verify_result: VerifyResult | null; config: Partial<BackupConfig>;
    }>(
      `SELECT id, started_at, finished_at, kind, state, folder, destination, files, bytes::text AS bytes, db_bytes::text AS db_bytes, error, dump_name, migration,
              verified_at, verify_result, config
         FROM backup_runs WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 40`,
    )).rows;
    const out: BackupRun[] = [];
    for (const r of rows) {
      const local = r.kind !== 'ssh';
      out.push({
        id: Number(r.id), startedAt: r.started_at.toISOString(), finishedAt: r.finished_at ? r.finished_at.toISOString() : null, kind: r.kind, state: r.state,
        folder: r.folder, destination: r.destination, files: r.files, bytes: r.bytes === null ? null : Number(r.bytes), dbBytes: r.db_bytes === null ? null : Number(r.db_bytes),
        error: r.error, dumpName: r.dump_name, migration: r.migration, verifiedAt: r.verified_at ? r.verified_at.toISOString() : null, verify: r.verify_result,
        available: local ? await exists(r.destination) : null, canManage: local && this.rootsOk(resolve(r.destination)),
        withDb: r.config.withDb !== false, withFiles: r.config.withFiles !== false && r.config.mirror !== false,
      });
    }
    return out;
  }

  // Папка копии должна лежать строго внутри диска для копий или USB-диска, сам диск трогать нельзя.
  private rootsOk(dir: string): boolean {
    for (const root of [this.cfg.backupDir, this.cfg.usbDir]) {
      if (!root) continue;
      if (dir.startsWith(resolve(root) + sep)) return true;
    }
    return false;
  }

  private async managedRun(id: number): Promise<{ id: number; dir: string; state: string; config: BackupConfig; dumpName: string | null; migration: string | null }> {
    const r = (await this.db.query<{ id: string; kind: string; state: string; destination: string; dump_name: string | null; migration: string | null; config: Partial<BackupConfig> }>(
      'SELECT id, kind, state, destination, dump_name, migration, config FROM backup_runs WHERE id = $1 AND deleted_at IS NULL', [id],
    )).rows[0];
    if (!r) throw new NotFoundException('Такой копии нет в журнале');
    if (r.kind === 'ssh') throw new BadRequestException('Копия лежит на другом сервере: проверка, удаление и восстановление делаются на нём самом (см. docs/BACKUP.md)');
    if (r.state === 'running') throw new ConflictException('Эта копия ещё идёт');
    const dir = resolve(r.destination);
    if (!this.rootsOk(dir)) throw new BadRequestException('Папка копии вне диска для копий');
    if (!(await exists(dir))) throw new BadRequestException('Папки копии нет на месте. Диск подключён? Если папку удалили вручную, уберите запись кнопкой «Удалить»');
    return { id: Number(r.id), dir, state: r.state, config: { ...DEFAULT_BACKUP, ...r.config }, dumpName: r.dump_name, migration: r.migration };
  }

  private begin(action: BackupAction, runId: number, step: string): BackupJob {
    if (this.job?.state === 'running') throw new ConflictException('Сейчас уже идёт работа с копиями: дождитесь конца или остановите её');
    this.stopRequested = false;
    const job: BackupJob = { action, runId, note: null, state: 'running', step, percent: null, startedAt: new Date().toISOString(), finishedAt: null, error: null, result: null };
    this.job = job;
    return job;
  }

  private stopIf(): void { if (this.stopRequested) throw new Error('Остановлено вами'); }

  private async finishAction(job: BackupJob, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      job.state = 'done'; job.step = 'Готово'; job.percent = 100;
    } catch (e) {
      job.state = 'error'; job.error = e instanceof Error ? e.message : String(e); job.step = 'Остановлено';
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  }

  private progress(job: BackupJob): (s: string) => void {
    return (s) => { const m = [...s.matchAll(/(\d{1,3})%/g)].pop(); if (m) job.percent = Math.min(100, Number(m[1])); };
  }

  private pgArgs(): { conn: string[]; env: NodeJS.ProcessEnv; db: string } {
    const u = new URL(this.cfg.databaseUrl);
    return { conn: ['-h', u.hostname, '-p', u.port || '5432', '-U', decodeURIComponent(u.username)], env: { PGPASSWORD: decodeURIComponent(u.password), PGOPTIONS: '-c lock_timeout=60000' }, db: u.pathname.slice(1) };
  }

  // Проверка копии: выгрузка базы читается, файлы на месте и совпадают по размеру с облаком. Ничего не меняет.
  async verify(id: number): Promise<BackupJob> {
    const run = await this.managedRun(id);
    const job = this.begin('verify', id, 'Проверяю копию');
    void this.finishAction(job, async () => {
      const c = run.config;
      const res: VerifyResult = { dumpOk: null, dumpName: run.dumpName, newer: 0, differ: 0, filesChecked: false };
      if (c.withDb) {
        job.step = 'Проверяю выгрузку базы';
        const dump = run.dumpName ? join(run.dir, 'db', run.dumpName) : '';
        if (!dump || !(await exists(dump))) res.dumpOk = false;
        else { const r = await this.run('pg_restore', ['--list', dump]); this.stopIf(); res.dumpOk = r.code === 0 && /TABLE public files /.test(r.out); }
      }
      if (c.withFiles && c.mirror) {
        job.step = 'Сверяю файлы копии с облаком';
        const skip = [...ALWAYS_SKIP, ...(c.withTrash ? [] : TRASH), ...(c.withDerived ? [] : DERIVED)];
        const files = join(run.dir, 'files');
        if (!(await exists(files))) throw new Error('В копии нет папки files: точная копия не делалась или папку удалили');
        const r = await this.run('nice', ['-n', '19', 'rsync', '-rn', '--size-only', '--itemize-changes', '--no-inc-recursive', ...skip.flatMap((d) => ['--exclude', d]), `${resolve(this.cfg.dataDir)}/`, `${files}/`]);
        this.stopIf();
        if (r.code !== 0 && r.code !== 24) throw new Error(`Сверка не получилась: ${this.tidy(r.err) || `код ${r.code}`}`);
        for (const l of r.out.split('\n')) {
          if (/^>f\+{9}/.test(l)) res.newer++;
          else if (/^>f/.test(l)) res.differ++;
        }
        res.filesChecked = true;
      }
      await this.db.query('UPDATE backup_runs SET verified_at = now(), verify_result = $2::jsonb WHERE id = $1', [id, JSON.stringify(res)]);
      const bad = res.dumpOk === false || res.differ > 0;
      job.note = `${bad ? 'Есть проблемы' : 'Копия в порядке'}: ${res.dumpOk === null ? '' : res.dumpOk ? 'выгрузка базы читается; ' : 'выгрузка базы не читается или не найдена; '}${res.filesChecked ? `${res.differ} файлов отличаются по размеру, ${res.newer} новее копии (появились после неё)` : 'файлы не проверялись'}`;
      if (bad) throw new Error(job.note);
    });
    return job;
  }

  // Удаление копии с диска. Подтверждение: имя папки копии. Записи в журнале остаются, помеченные как удалённые.
  async remove(id: number, confirm: string): Promise<BackupJob> {
    const run = await this.managedRun(id);
    if (confirm !== basename(run.dir)) throw new BadRequestException(`Для удаления введите имя папки копии: ${basename(run.dir)}`);
    const job = this.begin('delete', id, 'Удаляю копию с диска');
    void this.finishAction(job, async () => {
      const r = await this.run('nice', ['-n', '19', 'rm', '-rf', '--', run.dir]);
      this.stopIf();
      if (r.code !== 0) throw new Error(`Не удалось удалить: ${this.tidy(r.err) || `код ${r.code}`}`);
      await this.db.query('UPDATE backup_runs SET deleted_at = now() WHERE destination = $1 AND deleted_at IS NULL', [run.dir]);
      job.note = 'Копия удалена с диска';
    });
    return job;
  }

  // Убрать из журнала запись, у которой папки уже нет (например, диск чистили вручную).
  async forget(id: number): Promise<void> {
    const r = (await this.db.query<{ destination: string; kind: string; state: string }>('SELECT destination, kind, state FROM backup_runs WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0];
    if (!r) throw new NotFoundException('Такой копии нет в журнале');
    if (r.state === 'running') throw new ConflictException('Эта копия ещё идёт');
    if (r.kind !== 'ssh' && (await exists(r.destination))) throw new BadRequestException('Папка копии на месте: сначала удалите копию кнопкой «Удалить с диска»');
    await this.db.query('UPDATE backup_runs SET deleted_at = now() WHERE id = $1', [id]);
  }

  // Восстановление файлов из точной копии в облако. По умолчанию возвращает только недостающие файлы и ничего не перезаписывает.
  async restoreFiles(id: number, confirm: string, overwrite: boolean): Promise<BackupJob> {
    if (confirm !== CONFIRM_RESTORE) throw new BadRequestException(`Для восстановления введите слово ${CONFIRM_RESTORE}`);
    const run = await this.managedRun(id);
    const src = join(run.dir, 'files');
    if (!(await exists(src))) throw new BadRequestException('В этой копии нет точной копии файлов (папки files)');
    const job = this.begin('restore-files', id, 'Восстанавливаю файлы');
    void this.finishAction(job, async () => {
      job.percent = 0;
      const r = await this.run('nice', ['-n', '19', 'rsync', '-rt', '--no-perms', '--no-owner', '--no-group', '--modify-window=2', ...(overwrite ? [] : ['--ignore-existing']), '--info=progress2,stats2', '--no-inc-recursive',
        ...ALWAYS_SKIP.flatMap((d) => ['--exclude', d]), `${src}/`, `${resolve(this.cfg.dataDir)}/`], 0, this.progress(job));
      this.stopIf();
      if (r.code !== 0 && r.code !== 24) throw new Error(`Восстановление остановилось: ${this.tidy(r.err) || `код ${r.code}`}`);
      const n = Number((/Number of regular files transferred: ([\d,.]+)/.exec(r.out)?.[1] ?? '0').replace(/[,.\s]/g, ''));
      job.note = `Возвращено файлов: ${n}`;
    });
    return job;
  }

  // Восстановление базы из выгрузки копии. Только если копия сделана той же версией базы; перед этим делается страховочная выгрузка текущей базы.
  // Всё в одной транзакции: при остановке или ошибке база остаётся прежней.
  async restoreDb(id: number, confirm: string): Promise<BackupJob> {
    if (confirm !== CONFIRM_RESTORE_DB) throw new BadRequestException(`Для восстановления базы введите: ${CONFIRM_RESTORE_DB}`);
    const run = await this.managedRun(id);
    if (!run.dumpName) throw new BadRequestException('В этой копии нет выгрузки базы');
    const dump = join(run.dir, 'db', run.dumpName);
    if (!(await exists(dump))) throw new BadRequestException('Файла выгрузки базы нет на месте');
    const cur = (await this.db.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1')).rows[0]?.name ?? null;
    if (run.migration !== cur) throw new BadRequestException(`Копия сделана другой версией базы (${run.migration ?? 'неизвестно'}, сейчас ${cur ?? 'неизвестно'}). Такую базу восстанавливайте вручную по docs/BACKUP.md`);
    const job = this.begin('restore-db', id, 'Страхую текущую базу');
    void this.finishAction(job, async () => {
      const pg = this.pgArgs();
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
      const safety = join(run.dir, 'db', `before-restore-${stamp}.dump`);
      const sv = await this.run('nice', ['-n', '19', 'pg_dump', '-Fc', '--exclude-table=backup_runs', '--exclude-table=backup_runs_id_seq', ...pg.conn, '-d', pg.db, '-f', safety], 0, undefined, pg.env);
      this.stopIf();
      if (sv.code !== 0) throw new Error(`Не удалось сделать страховочную выгрузку, восстановление не начато: ${this.tidy(sv.err) || `код ${sv.code}`}`);
      job.step = 'Восстанавливаю базу';
      const r = await this.run('pg_restore', ['--clean', '--if-exists', '--single-transaction', '--no-owner', '--no-privileges', ...pg.conn, '-d', pg.db, dump], 0, undefined, pg.env);
      this.stopIf();
      if (r.code !== 0) throw new Error(`Восстановление базы не удалось, база осталась прежней: ${this.tidy(r.err) || `код ${r.code}`}`);
      job.note = 'База восстановлена из копии. Страховочная выгрузка прежней базы лежит в папке db этой копии';
    });
    return job;
  }

  // Оставляет несколько последних выгрузок базы, старые стирает (только файлы dvcloud-*.dump в папке db).
  private async prune(c: BackupConfig, target: string): Promise<void> {
    if (c.kind !== 'ssh') {
      const dir = join(target, 'db');
      const names = (await readdir(dir)).filter((n) => /^dvcloud-\d{8}-\d{6}\.dump$/.test(n)).sort();
      for (const n of names.slice(0, Math.max(0, names.length - DUMPS_KEEP))) await rm(join(dir, n), { force: true });
      return;
    }
    const cmd = `cd ${c.path}/db && ls -1 | grep -E '^dvcloud-[0-9]{8}-[0-9]{6}\\.dump$' | sort | head -n -${DUMPS_KEEP} | xargs -r rm -f --`;
    await this.run('ssh', [...this.sshArgs(c), `${c.user}@${c.host}`, cmd], 30000);
  }
}
