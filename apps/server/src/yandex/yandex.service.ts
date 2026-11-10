import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { Config } from '../config';
import { DbService } from '../db/db.service';
import { ActivityService } from '../files/activity.service';
import { AlbumsService } from '../files/albums.service';
import { FilesService } from '../files/files.service';
import { cleanFileName } from '../files/names';
import { StorageService, TooLargeError } from '../files/storage.service';
import { CONFIG } from '../tokens';
import { UserRow, UsersService } from '../users/users.service';
import { open as unseal, seal } from './crypto';
import { YandexAuthError, YandexDisk, YandexGone, YandexRateLimit, YandexUnavailable } from './disk.client';
import { LoginClient } from './login.client';

const ALBUM_NAME = 'Яндекс Диск';
const NEED_COOKIES = ['Session_id', 'yandexuid', 'sessionid2'];
const retryMin = (): number => Number(process.env.DVCLOUD_YANDEX_RETRY_MIN ?? 30); // отложенные файлы пробуем снова через столько минут (в тестах меньше)
const MAX_ATTEMPTS = 8;
const PENDING_TTL_MS = 10 * 60_000;
const syncCheckMs = (): number => Number(process.env.DVCLOUD_YANDEX_SYNC_CHECK_MS ?? 60_000); // как часто тик проверяет, пора ли сверять

type Counts = Record<'new' | 'queued' | 'done' | 'waiting' | 'failed' | 'skipped', number>;

export interface YandexStatus {
  enabled: boolean;
  connected: boolean;
  state?: 'connected' | 'expired';
  list?: { state: 'idle' | 'running' | 'error'; note: string | null; at: string | null };
  counts?: Counts;
  bytes?: { total: number; done: number; remaining: number };
  years?: { year: number | null; n: number; bytes: number; todo: number }[];
  import?: { state: 'idle' | 'running' | 'paused'; note: string | null; intoAlbum: boolean; current: { name: string; size: number; got: number } | null; speed: number; etaSec: number | null };
  sync?: { auto: boolean; autoImport: boolean; at: string | null; found: number | null; foundBytes: number | null; pending: number };
  quota?: { freeBytes: number | null; needBytes: number; fits: boolean };
}

interface AccountRow {
  id: string;
  owner_id: string;
  session: Buffer;
  state: 'connected' | 'expired';
  listed_at: Date | null;
  list_state: 'idle' | 'running' | 'error';
  list_note: string | null;
  import_state: 'idle' | 'running' | 'paused';
  import_note: string | null;
  into_album: boolean;
  auto_sync: boolean;
  sync_days: number;
  auto_import: boolean;
  sync_at: Date | null;
  sync_found: number | null;
  sync_found_bytes: string | null;
}

interface ItemRow {
  id: string;
  account_id: string;
  path: string;
  name: string;
  size_bytes: string;
  md5: string | null;
  taken_hint: Date | null;
  attempts: number;
}

// «Яндекс Диск»: подключение по QR, чтение списка безлимита и фоновый забор файлов в библиотеку человека. Только в одну сторону:
// у Яндекса мы ничего не пишем и не удаляем, а удаление у них ничего не удаляет у нас.
@Injectable()
export class YandexService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Yandex');
  private readonly pending = new Map<string, { userId: string; at: number }>(); // идущие входы по QR
  private readonly disks = new Map<string, YandexDisk>(); // открытые сессии по номеру аккаунта
  private readonly current = new Map<string, { name: string; size: number; got: () => number }>();
  private readonly albums = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;
  private coolUntil = 0;
  private lastSyncCheck = 0;

  constructor(
    @Inject(CONFIG) private readonly cfg: Config,
    @Inject(DbService) private readonly db: DbService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(AlbumsService) private readonly albumsSvc: AlbumsService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(LoginClient) private readonly login: LoginClient,
  ) {}

  get enabled(): boolean {
    return this.login.configured;
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    const ms = Number(process.env.DVCLOUD_YANDEX_TICK_MS ?? 5000);
    this.timer = setInterval(() => void this.tick(), Number.isFinite(ms) && ms >= 50 ? ms : 5000);
    this.timer.unref();
    void this.db.query("UPDATE yandex_accounts SET list_state = 'error', list_note = 'Чтение списка прервано перезапуском сервера' WHERE list_state = 'running'").catch(() => undefined);
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
  }

  private need(): void {
    if (!this.enabled) throw new ServiceUnavailableException('Раздел «Яндекс Диск» не настроен администратором');
  }

  private async account(userId: string): Promise<AccountRow | null> {
    return (await this.db.query<AccountRow>('SELECT * FROM yandex_accounts WHERE owner_id = $1', [userId])).rows[0] ?? null;
  }

  private async mustAccount(userId: string): Promise<AccountRow> {
    this.need();
    const a = await this.account(userId);
    if (!a) throw new NotFoundException('Яндекс Диск не подключён');
    return a;
  }

  // ── Подключение по QR ───────────────────────────────────────────────────

  async connectStart(user: UserRow): Promise<{ id: string }> {
    this.need();
    for (const [k, v] of this.pending) if (Date.now() - v.at > PENDING_TTL_MS) this.pending.delete(k);
    let id: string;
    try {
      id = await this.login.start();
    } catch (e) {
      throw new ServiceUnavailableException((e as Error).message);
    }
    this.pending.set(id, { userId: user.id, at: Date.now() });
    return { id };
  }

  private mine(user: UserRow, id: string): void {
    const p = this.pending.get(id);
    if (!p || p.userId !== user.id) throw new NotFoundException('Вход не найден или устарел: начните заново');
  }

  async connectQr(user: UserRow, id: string): Promise<Buffer | null> {
    this.need();
    this.mine(user, id);
    try {
      return await this.login.qr(id);
    } catch (e) {
      throw new ServiceUnavailableException((e as Error).message);
    }
  }

  async connectStatus(user: UserRow, id: string): Promise<{ state: 'waiting' | 'done' | 'failed'; note?: string }> {
    this.need();
    this.mine(user, id);
    let st;
    try {
      st = await this.login.status(id);
    } catch (e) {
      throw new ServiceUnavailableException((e as Error).message);
    }
    if (st.state === 'waiting') return { state: 'waiting' };
    if (st.state === 'failed') {
      this.pending.delete(id);
      await this.login.finish(id);
      return { state: 'failed', note: st.note };
    }
    if (st.state === 'unknown') {
      this.pending.delete(id);
      return { state: 'failed', note: 'Вход устарел: начните заново' };
    }
    // Вход подтверждён: оставляем только куки Яндекса, проверяем, что они действуют, и сохраняем зашифрованными.
    const jar: Record<string, string> = {};
    for (const c of st.cookies) if (/yandex\./.test(c.domain) && c.name && c.value) jar[c.name] = c.value;
    this.pending.delete(id);
    await this.login.finish(id);
    const miss = NEED_COOKIES.filter((n) => !jar[n]);
    if (miss.length > 0) return { state: 'failed', note: 'Яндекс не выдал нужные данные входа. Попробуйте ещё раз.' };
    const disk = new YandexDisk(this.cfg.yandexBase, jar);
    try {
      await disk.open();
    } catch (e) {
      return { state: 'failed', note: e instanceof YandexAuthError ? 'Яндекс не принял вход. Попробуйте ещё раз.' : 'Яндекс сейчас не отвечает. Попробуйте позже.' };
    }
    const row = await this.db.query<{ id: string }>(
      `INSERT INTO yandex_accounts (owner_id, session) VALUES ($1, $2)
       ON CONFLICT (owner_id) DO UPDATE SET session = EXCLUDED.session, state = 'connected', connected_at = now(),
         import_note = CASE WHEN yandex_accounts.import_state = 'paused' THEN 'Вход подтверждён заново. Нажмите «Продолжить».' ELSE yandex_accounts.import_note END
       RETURNING id`,
      [user.id, seal(this.cfg.secretsKey, jar)],
    );
    this.disks.set(row.rows[0].id, disk);
    return { state: 'done' };
  }

  // Отключить: сессия и список стираются. Уже забранные файлы остаются у человека.
  async disconnect(user: UserRow): Promise<void> {
    const a = await this.account(user.id);
    if (!a) return;
    this.disks.delete(a.id);
    this.albums.delete(a.id);
    await this.db.query('DELETE FROM yandex_accounts WHERE id = $1', [a.id]);
  }

  private diskOf(a: AccountRow): YandexDisk {
    let d = this.disks.get(a.id);
    if (!d) {
      d = new YandexDisk(this.cfg.yandexBase, unseal<Record<string, string>>(this.cfg.secretsKey, a.session));
      this.disks.set(a.id, d);
    }
    return d;
  }

  private async expire(a: AccountRow): Promise<void> {
    this.disks.delete(a.id);
    await this.db.query(
      "UPDATE yandex_accounts SET state = 'expired', import_state = CASE WHEN import_state = 'running' THEN 'paused' ELSE import_state END, import_note = 'Вход в Яндекс устарел: подтвердите его на телефоне снова' WHERE id = $1",
      [a.id],
    );
  }

  // ── Список файлов ───────────────────────────────────────────────────────

  async startList(user: UserRow): Promise<void> {
    const a = await this.mustAccount(user.id);
    if (a.state === 'expired') throw new ConflictException('Вход в Яндекс устарел: подтвердите его на телефоне снова');
    const r = await this.db.query("UPDATE yandex_accounts SET list_state = 'running', list_note = 'Читаю список…' WHERE id = $1 AND list_state <> 'running' RETURNING id", [a.id]);
    if (r.rowCount === 0) throw new ConflictException('Список уже читается');
    void this.doList(a);
  }

  private async doList(a: AccountRow): Promise<void> {
    let n = 0;
    const resync = a.listed_at !== null; // не первое чтение: найденное новое считаем итогом сверки
    try {
      const began = (await this.db.query<{ t: Date }>('SELECT now() AS t')).rows[0].t;
      const disk = this.diskOf(a);
      await disk.open();
      for await (const page of disk.listUnlim()) {
        await this.db.query(
          `INSERT INTO yandex_items (account_id, path, name, size_bytes, md5, taken_hint)
           SELECT $1, * FROM unnest($2::text[], $3::text[], $4::bigint[], $5::text[], $6::timestamptz[])
           ON CONFLICT (account_id, path) DO UPDATE SET name = EXCLUDED.name, size_bytes = EXCLUDED.size_bytes, md5 = EXCLUDED.md5,
             taken_hint = EXCLUDED.taken_hint,
             state = CASE WHEN yandex_items.state = 'done' AND EXCLUDED.md5 IS NOT NULL AND yandex_items.md5 IS NOT NULL
                          AND EXCLUDED.md5 <> yandex_items.md5 THEN 'new' ELSE yandex_items.state END`,
          [a.id, page.map((f) => f.path), page.map((f) => f.name), page.map((f) => f.size), page.map((f) => f.md5), page.map((f) => f.mtime)],
        );
        n += page.length;
        await this.db.query('UPDATE yandex_accounts SET list_note = $2 WHERE id = $1', [a.id, `Прочитано файлов: ${n}`]);
      }
      await this.db.query("UPDATE yandex_accounts SET list_state = 'idle', list_note = $2, listed_at = now() WHERE id = $1", [a.id, `Всего в безлимите: ${n}`]);
      if (resync) await this.afterResync(a, began);
    } catch (e) {
      if (e instanceof YandexAuthError) await this.expire(a);
      const msg = e instanceof YandexAuthError ? 'Вход в Яндекс устарел' : e instanceof YandexRateLimit ? 'Яндекс просит не частить, повторите позже' : e instanceof YandexUnavailable ? e.message : 'Не удалось прочитать список';
      this.log.warn(`список: ${(e as Error).message}`);
      await this.db.query("UPDATE yandex_accounts SET list_state = 'error', list_note = $2 WHERE id = $1", [a.id, `${msg} (прочитано ${n})`]);
    }
  }

  // Итог сверки: сколько нового нашлось (появилось в списке после её начала). Если включён автозабор, новое сразу ставится в очередь.
  private async afterResync(a: AccountRow, began: Date): Promise<void> {
    const f = (await this.db.query<{ n: string; b: string }>("SELECT count(*) AS n, COALESCE(sum(size_bytes), 0) AS b FROM yandex_items WHERE account_id = $1 AND state = 'new' AND found_at >= $2", [a.id, began])).rows[0];
    await this.db.query('UPDATE yandex_accounts SET sync_at = now(), sync_found = $2, sync_found_bytes = $3 WHERE id = $1', [a.id, Number(f.n), Number(f.b)]);
    if (!a.auto_import || Number(f.n) === 0) return;
    // автозабор не отменяет вашу паузу: остановленное вами остаётся остановленным, новое ждёт кнопки
    const st = (await this.db.query<{ import_state: string }>('SELECT import_state FROM yandex_accounts WHERE id = $1', [a.id])).rows[0]?.import_state;
    if (st === 'paused') return;
    await this.db.query("UPDATE yandex_items SET state = 'queued', attempts = 0, error = NULL, updated_at = now() WHERE account_id = $1 AND state = 'new' AND found_at >= $2", [a.id, began]);
    await this.db.query("UPDATE yandex_accounts SET import_state = 'running', import_note = NULL WHERE id = $1", [a.id]);
  }

  async setSettings(user: UserRow, s: { autoSync?: boolean; autoImport?: boolean; syncDays?: number }): Promise<void> {
    const a = await this.mustAccount(user.id);
    await this.db.query('UPDATE yandex_accounts SET auto_sync = COALESCE($2, auto_sync), auto_import = COALESCE($3, auto_import), sync_days = COALESCE($4, sync_days) WHERE id = $1', [a.id, s.autoSync ?? null, s.autoImport ?? null, s.syncDays ?? null]);
  }

  // Ночная сверка: с выбранной частотой (каждую ночь, раз в неделю, раз в месяц), в окне часов сервера (по умолчанию с 2 до 6),
  // либо если сверка запоздала больше чем на два дня.
  // Читается только список; сами файлы забираются, если у человека включён автозабор. Вызывается из tick раз в минуту.
  async autoSync(now = new Date()): Promise<number> {
    const from = Number(process.env.DVCLOUD_YANDEX_SYNC_FROM ?? 2), to = Number(process.env.DVCLOUD_YANDEX_SYNC_TO ?? 6);
    const h = now.getHours();
    const night = from <= to ? h >= from && h < to : h >= from || h < to;
    const due = await this.db.query<AccountRow>(
      `SELECT * FROM yandex_accounts WHERE auto_sync AND state = 'connected' AND list_state <> 'running' AND listed_at IS NOT NULL
         AND (listed_at < now() - interval '1 hour' * (sync_days * 24 - 4) AND $1::boolean OR listed_at < now() - interval '1 day' * (sync_days + 2)) ORDER BY id`,
      [night],
    );
    let started = 0;
    for (const a of due.rows) {
      const r = await this.db.query("UPDATE yandex_accounts SET list_state = 'running', list_note = 'Ночная сверка: читаю список…' WHERE id = $1 AND list_state <> 'running' RETURNING id", [a.id]);
      if (r.rowCount) { started++; void this.doList(a); }
    }
    return started;
  }

  // ── Запуск и остановка забора ───────────────────────────────────────────

  // years: забрать только эти годы (null в списке = файлы без даты). Без years забирается всё. retryFailed возвращает упавшие.
  async startImport(user: UserRow, opts: { years?: (number | null)[]; retryFailed?: boolean; intoAlbum?: boolean }): Promise<{ queued: number }> {
    const a = await this.mustAccount(user.id);
    if (a.state === 'expired') throw new ConflictException('Вход в Яндекс устарел: подтвердите его на телефоне снова');
    const states = opts.retryFailed ? ['new', 'failed'] : ['new'];
    const years = opts.years && opts.years.length > 0 ? opts.years : null;
    const withNull = years?.includes(null) ?? false;
    const nums = (years ?? []).filter((y): y is number => typeof y === 'number');
    const q = await this.db.query(
      `UPDATE yandex_items SET state = 'queued', attempts = 0, error = NULL, updated_at = now()
       WHERE account_id = $1 AND state = ANY($2::text[])
         AND ($3::boolean IS FALSE OR (taken_hint IS NULL AND $4::boolean) OR extract(year FROM taken_hint)::int = ANY($5::int[]))`,
      [a.id, states, years !== null, withNull, nums],
    );
    await this.db.query("UPDATE yandex_accounts SET import_state = 'running', import_note = NULL, into_album = COALESCE($2, into_album) WHERE id = $1", [a.id, opts.intoAlbum ?? null]);
    return { queued: q.rowCount ?? 0 };
  }

  // Больше не пробовать файлы, которые Яндекс не отдаёт (ждут повтора или упали): они получают отметку «пропущен» и остаются в списке с причиной.
  // Если больше нечего забирать, забор закрывается. Новая сверка их не возвращает; снова взять их можно кнопкой «Повторить неудачные» только для упавших,
  // а пропущенные возвращает «Вернуть пропущенные».
  async skipUnavailable(user: UserRow): Promise<{ skipped: number }> {
    const a = await this.mustAccount(user.id);
    const r = await this.db.query(
      "UPDATE yandex_items SET state = 'skipped', updated_at = now() WHERE account_id = $1 AND state IN ('waiting', 'failed')",
      [a.id],
    );
    const left = Number((await this.db.query<{ n: string }>("SELECT count(*) AS n FROM yandex_items WHERE account_id = $1 AND state = 'queued'", [a.id])).rows[0].n);
    if (left === 0 && (r.rowCount ?? 0) > 0) await this.db.query("UPDATE yandex_accounts SET import_state = 'idle', import_note = 'Всё забрано, что Яндекс отдаёт. Остальное пропущено' WHERE id = $1 AND import_state = 'running'", [a.id]);
    return { skipped: r.rowCount ?? 0 };
  }

  // Вернуть в очередь то, что пропустили (когда Яндекс снова отдаёт эти файлы).
  async unskip(user: UserRow): Promise<{ queued: number }> {
    const a = await this.mustAccount(user.id);
    const r = await this.db.query(
      "UPDATE yandex_items SET state = 'queued', attempts = 0, error = NULL, updated_at = now() WHERE account_id = $1 AND state = 'skipped' AND (error IS NULL OR error NOT LIKE 'Не фото и не видео%')",
      [a.id],
    );
    if ((r.rowCount ?? 0) > 0) await this.db.query("UPDATE yandex_accounts SET import_state = 'running', import_note = NULL WHERE id = $1", [a.id]);
    return { queued: r.rowCount ?? 0 };
  }

  async resumeImport(user: UserRow): Promise<void> {
    const a = await this.mustAccount(user.id);
    if (a.state === 'expired') throw new ConflictException('Вход в Яндекс устарел: подтвердите его на телефоне снова');
    await this.db.query("UPDATE yandex_accounts SET import_state = 'running', import_note = NULL WHERE id = $1", [a.id]);
  }

  async pauseImport(user: UserRow): Promise<void> {
    const a = await this.mustAccount(user.id);
    await this.db.query("UPDATE yandex_accounts SET import_state = 'paused', import_note = 'Остановлено вами' WHERE id = $1 AND import_state = 'running'", [a.id]);
  }

  // ── Состояние для сайта ─────────────────────────────────────────────────

  async status(user: UserRow): Promise<YandexStatus> {
    if (!this.enabled) return { enabled: false, connected: false };
    const a = await this.account(user.id);
    if (!a) return { enabled: true, connected: false };
    const counts: Counts = { new: 0, queued: 0, done: 0, waiting: 0, failed: 0, skipped: 0 };
    let total = 0, done = 0;
    for (const r of (await this.db.query<{ state: keyof Counts; n: string; b: string }>('SELECT state, count(*) AS n, COALESCE(sum(size_bytes), 0) AS b FROM yandex_items WHERE account_id = $1 GROUP BY state', [a.id])).rows) {
      counts[r.state] = Number(r.n);
      total += Number(r.b);
      if (r.state === 'done') done += Number(r.b);
    }
    const years = (
      await this.db.query<{ y: number | null; n: string; b: string; t: string }>(
        `SELECT extract(year FROM taken_hint)::int AS y, count(*) AS n, COALESCE(sum(size_bytes), 0) AS b,
                COALESCE(sum(size_bytes) FILTER (WHERE state IN ('new', 'queued', 'waiting', 'failed')), 0) AS t
         FROM yandex_items WHERE account_id = $1 GROUP BY 1 ORDER BY 1 DESC NULLS LAST`,
        [a.id],
      )
    ).rows.map((r) => ({ year: r.y, n: Number(r.n), bytes: Number(r.b), todo: Number(r.t) }));
    const recent = await this.db.query<{ b: string }>("SELECT COALESCE(sum(size_bytes), 0) AS b FROM yandex_items WHERE account_id = $1 AND state = 'done' AND updated_at > now() - interval '5 minutes'", [a.id]);
    const speed = Math.round(Number(recent.rows[0].b) / 300);
    const remaining = Math.max(0, total - done);
    const cur = this.current.get(a.id);
    const need = (await this.db.query<{ b: string }>("SELECT COALESCE(sum(size_bytes), 0) AS b FROM yandex_items WHERE account_id = $1 AND state IN ('new', 'queued', 'waiting', 'failed')", [a.id])).rows[0].b;
    const est = await this.files.estimate(user, Number(need));
    const sync = { auto: a.auto_sync, days: a.sync_days, autoImport: a.auto_import, at: a.sync_at?.toISOString() ?? null, found: a.sync_found, foundBytes: a.sync_found_bytes === null ? null : Number(a.sync_found_bytes), pending: counts.new + counts.queued };
    return {
      enabled: true,
      connected: true,
      state: a.state,
      list: { state: a.list_state, note: a.list_note, at: a.listed_at?.toISOString() ?? null },
      counts,
      bytes: { total, done, remaining },
      years,
      import: { state: a.import_state, note: a.import_note, intoAlbum: a.into_album, current: cur ? { name: cur.name, size: cur.size, got: cur.got() } : null, speed, etaSec: speed > 0 && a.import_state === 'running' ? Math.round(remaining / speed) : null },
      sync,
      quota: { freeBytes: est.freeBytes, needBytes: est.needBytes, fits: est.fits },
    };
  }

  async items(user: UserRow, state: string | undefined, limit: number, offset: number): Promise<{ items: { name: string; size: number; takenHint: string | null; state: string; error: string | null; fileId: string | null }[]; total: number }> {
    const a = await this.mustAccount(user.id);
    const st = state && ['new', 'queued', 'done', 'waiting', 'failed', 'skipped'].includes(state) ? state : null;
    const where = st ? 'AND state = $2' : 'AND $2::text IS NULL';
    const total = Number((await this.db.query<{ n: string }>(`SELECT count(*) AS n FROM yandex_items WHERE account_id = $1 ${where}`, [a.id, st])).rows[0].n);
    const r = await this.db.query<{ name: string; size_bytes: string; taken_hint: Date | null; state: string; error: string | null; file_id: string | null }>(
      `SELECT name, size_bytes, taken_hint, state, error, file_id FROM yandex_items WHERE account_id = $1 ${where} ORDER BY taken_hint DESC NULLS LAST, id DESC LIMIT $3 OFFSET $4`,
      [a.id, st, Math.min(Math.max(limit, 1), 200), Math.max(offset, 0)],
    );
    return { total, items: r.rows.map((x) => ({ name: x.name, size: Number(x.size_bytes), takenHint: x.taken_hint?.toISOString() ?? null, state: x.state, error: x.error, fileId: x.file_id })) };
  }

  // ── Забор файлов ────────────────────────────────────────────────────────

  async tick(): Promise<void> {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      if (Date.now() - this.lastSyncCheck >= syncCheckMs()) {
        this.lastSyncCheck = Date.now();
        await this.autoSync().catch((e) => this.log.warn(`автосверка: ${(e as Error).message}`));
      }
      // Идём по всем идущим аккаунтам по очереди: пока у одного есть что брать, берём его; когда делать нечего (всё забрано или
      // файлы ждут повтора), переходим к следующему. Раньше брался всегда первый аккаунт, и если ему было нечего делать,
      // остальные не получали очереди никогда.
      const ids = (await this.db.query<{ id: string }>("SELECT id FROM yandex_accounts WHERE import_state = 'running' AND state = 'connected' ORDER BY id")).rows.map((r) => r.id);
      for (const id of ids) {
        for (;;) {
          if (this.stopping || Date.now() < this.coolUntil) return;
          const a = (await this.db.query<AccountRow>("SELECT * FROM yandex_accounts WHERE id = $1 AND import_state = 'running' AND state = 'connected'", [id])).rows[0];
          if (!a) break;
          if (!(await this.step(a))) break;
        }
      }
    } catch (e) {
      this.log.warn(`проход прерван: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  // Один шаг по аккаунту: взять следующий файл и забрать его. false: сейчас делать нечего (всё забрано или файлы ждут повтора).
  private async step(a: AccountRow): Promise<boolean> {
    await this.db.query(
      `UPDATE yandex_items SET state = 'queued' WHERE account_id = $1 AND state = 'waiting' AND updated_at < now() - ($2 || ' minutes')::interval`,
      [a.id, String(retryMin())],
    );
    const it = (
      await this.db.query<ItemRow>(
        "SELECT * FROM yandex_items WHERE account_id = $1 AND state = 'queued' ORDER BY taken_hint DESC NULLS LAST, id LIMIT 1",
        [a.id],
      )
    ).rows[0];
    if (!it) {
      const w = Number((await this.db.query<{ n: string }>("SELECT count(*) AS n FROM yandex_items WHERE account_id = $1 AND state = 'waiting'", [a.id])).rows[0].n);
      if (w > 0) await this.db.query("UPDATE yandex_accounts SET import_note = $2 WHERE id = $1", [a.id, `Яндекс не отдаёт ${w} файлов. Повторим сами каждые ${retryMin()} минут.`]);
      else await this.db.query("UPDATE yandex_accounts SET import_state = 'idle', import_note = 'Всё забрано' WHERE id = $1", [a.id]);
      return false;
    }
    const user = await this.users.findById(a.owner_id);
    if (!user || user.disabled) {
      await this.db.query("UPDATE yandex_accounts SET import_state = 'paused', import_note = 'Учётная запись отключена' WHERE id = $1", [a.id]);
      return false;
    }
    return this.importOne(a, user, it);
  }

  private async mark(it: ItemRow, state: 'done' | 'waiting' | 'failed' | 'skipped' | 'queued', error: string | null, fileId: string | null = null, bump = false): Promise<void> {
    await this.db.query(
      `UPDATE yandex_items SET state = $2, error = $3, file_id = COALESCE($4, file_id), attempts = attempts + $5, updated_at = now() WHERE id = $1`,
      [it.id, state, error, fileId, bump ? 1 : 0],
    );
  }

  private async toAlbum(a: AccountRow, user: UserRow, fileId: string): Promise<void> {
    if (!a.into_album) return;
    try {
      let id = this.albums.get(a.id);
      if (!id) {
        const found = await this.db.query<{ id: string }>('SELECT id FROM albums WHERE owner_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL', [user.id, ALBUM_NAME]);
        id = found.rows[0]?.id ?? (await this.albumsSvc.create(user.id, ALBUM_NAME)).id;
        this.albums.set(a.id, id);
      }
      try {
        await this.albumsSvc.addFiles(user.id, id, [fileId]);
      } catch (e) {
        if (!(e instanceof NotFoundException)) throw e;
        this.albums.delete(a.id); // человек удалил альбом: создадим заново на следующем файле
      }
    } catch (e) {
      this.log.warn(`альбом: ${(e as Error).message}`);
    }
  }

  private async importOne(a: AccountRow, user: UserRow, it: ItemRow): Promise<boolean> {
    const clean = cleanFileName(it.name);
    if (!clean) {
      await this.mark(it, 'skipped', 'Не фото и не видео: пока не забираем');
      return true;
    }
    const size = Number(it.size_bytes);
    const room = await this.files.room(user);
    if (size > this.cfg.maxUploadBytes) {
      await this.mark(it, 'failed', 'Файл больше допустимого размера');
      return true;
    }
    if (size > room) {
      await this.db.query("UPDATE yandex_accounts SET import_state = 'paused', import_note = 'Не хватает места в квоте. Попросите больше места и нажмите «Продолжить».' WHERE id = $1", [a.id]);
      return false;
    }
    // Файл с такой же контрольной суммой уже забран кем-то из семьи (или раньше нами): в облаке он хранится один раз,
    // поэтому ничего не скачиваем, а только создаём человеку ссылку на него.
    if (it.md5 && size > 0) {
      const twin = await this.db.query<{ sha256: string }>(
        `SELECT b.sha256 FROM yandex_items y JOIN files f ON f.id = y.file_id JOIN blobs b ON b.id = f.blob_id
         WHERE y.md5 = $1 AND y.size_bytes = $2 AND y.state = 'done' AND y.id <> $3 LIMIT 1`,
        [it.md5, size, it.id],
      );
      if (twin.rows[0]) {
        const r = (await this.files.claim(user, [{ sha256: twin.rows[0].sha256, name: it.name, modified: it.taken_hint?.toISOString() }]))[0];
        if (r?.file && (r.state === 'linked' || r.state === 'restored' || r.state === 'mine')) {
          await this.mark(it, 'done', 'Файл уже был в облаке: взята ссылка, скачивать не пришлось', r.file.id);
          await this.toAlbum(a, user, r.file.id);
          return true;
        }
        if (r?.state === 'quota') {
          await this.db.query("UPDATE yandex_accounts SET import_state = 'paused', import_note = 'Не хватает места в квоте. Попросите больше места и нажмите «Продолжить».' WHERE id = $1", [a.id]);
          return false;
        }
      }
    }
    // «Идёт загрузка» (фоновая работа уступает) отмечаем только на время обработки файла на сервере. Скачивание с Яндекса идёт
    // по сети, процессор почти не занят, а раньше оно держало «занято» целиком: миниатюры и отпечатки не строились, пока шёл импорт.
    let end = (): void => undefined;
    const tmp = this.storage.newTmp();
    try {
      const disk = this.diskOf(a);
      const url = await disk.fileUrl(it.path);
      const dl = await disk.download(url);
      this.current.set(a.id, { name: it.name, size, got: () => dl.bytes() });
      const { size: got, sha256 } = await this.storage.receive(dl.stream, tmp, room);
      if (got === 0 || (size > 0 && got !== size)) throw new YandexUnavailable(`Размер не совпал (пришло ${got}, ждали ${size})`);
      if (it.md5 && dl.md5() !== it.md5) throw new YandexUnavailable('Контрольная сумма не совпала');
      end = this.activity.begin();
      const res = await this.files.finishUpload(user, tmp, got, sha256, clean, it.taken_hint ?? new Date());
      await this.mark(it, 'done', null, res.file.id);
      await this.toAlbum(a, user, res.file.id);
      return true;
    } catch (e) {
      return await this.fail(a, it, e);
    } finally {
      this.current.delete(a.id);
      end();
      await rm(tmp, { force: true });
    }
  }

  // Что делать с ошибкой: true = продолжать со следующим файлом, false = остановить проход.
  private async fail(a: AccountRow, it: ItemRow, e: unknown): Promise<boolean> {
    if (e instanceof YandexAuthError) {
      await this.expire(a);
      return false;
    }
    if (e instanceof YandexRateLimit) {
      this.coolUntil = Date.now() + e.retryAfterSec * 1000;
      await this.mark(it, 'queued', null);
      await this.db.query("UPDATE yandex_accounts SET import_note = 'Яндекс просит не частить: небольшая пауза' WHERE id = $1", [a.id]);
      return false;
    }
    if (e instanceof YandexGone) {
      await this.mark(it, 'failed', 'Файла уже нет в Яндексе', null, true);
      return true;
    }
    if (e instanceof TooLargeError) {
      await this.db.query("UPDATE yandex_accounts SET import_state = 'paused', import_note = 'Не хватает места в квоте. Попросите больше места и нажмите «Продолжить».' WHERE id = $1", [a.id]);
      await this.mark(it, 'queued', null);
      return false;
    }
    const msg = e instanceof YandexUnavailable ? e.message : 'Не удалось забрать файл';
    this.log.warn(`файл: ${(e as Error).message}`);
    const attempts = it.attempts + 1;
    await this.mark(it, attempts >= MAX_ATTEMPTS ? 'failed' : 'waiting', `${msg}`, null, true);
    return true;
  }
}

export const newLoginId = (): string => randomBytes(16).toString('hex');
