import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, UnsupportedMediaTypeException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { readdir, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { DbService } from '../db/db.service';
import { UserRow } from '../users/users.service';
import { ActivityService } from './activity.service';
import { FileRow, FilesService } from './files.service';
import { cleanFileName, parseTakenAt } from './names';
import { StorageService, TooLargeError } from './storage.service';

export const CHUNK_MAX = 64 * 1024 * 1024; // больше одним куском не принимаем
export const CHUNK_HINT = 8 * 1024 * 1024; // рекомендуемый размер куска для клиента
const MAX_OPEN = 50; // незавершённых загрузок на человека
const STALE_MS = 3 * 24 * 3600 * 1000; // брошенная загрузка живёт трое суток

interface UploadRow {
  id: string;
  user_id: string;
  name: string;
  size_bytes: string;
  modified: string | null;
}

export interface UploadState {
  id: string;
  offset: number;
  size: number;
  chunk: number;
}

// Загрузка по частям с докачкой: клиент создаёт сессию, шлёт куски подряд и после обрыва спрашивает, сколько уже принято.
// Файл дописывается в конец, поэтому принято ровно столько байт, сколько лежит на диске. Когда набралась полная длина,
// считается SHA-256, и файл попадает в библиотеку так же, как при обычной загрузке (с общим хранением по хешу).
@Injectable()
export class UploadsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Uploads');
  private readonly locked = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(ActivityService) private readonly activity: ActivityService,
  ) {}

  onModuleInit(): void {
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), 3600_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // Удаляет брошенные сессии и файлы без сессии.
  async sweep(): Promise<void> {
    try {
      await this.db.query("DELETE FROM uploads WHERE updated_at < now() - ($1 || ' milliseconds')::interval", [String(STALE_MS)]);
      const known = new Set((await this.db.query<{ id: string }>('SELECT id FROM uploads')).rows.map((r) => r.id));
      for (const f of await readdir(this.storage.abs('uploads'))) if (!known.has(f)) await rm(this.storage.uploadPath(f), { force: true });
    } catch (e) {
      this.log.warn(`очистка загрузок: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async get(user: UserRow, id: string): Promise<UploadRow> {
    if (!/^[0-9a-f]{24}$/.test(id)) throw new NotFoundException('Загрузка не найдена');
    const r = await this.db.query<UploadRow>('SELECT * FROM uploads WHERE id = $1 AND user_id = $2', [id, user.id]);
    if (!r.rows[0]) throw new NotFoundException('Загрузка не найдена');
    return r.rows[0];
  }

  private async state(u: UploadRow): Promise<UploadState> {
    return { id: u.id, offset: await this.storage.uploadSize(u.id), size: Number(u.size_bytes), chunk: CHUNK_HINT };
  }

  // Создать сессию или найти ту же самую (имя, размер, дата): так загрузка продолжается и после перезагрузки страницы.
  async start(user: UserRow, meta: { name: unknown; size: unknown; modified?: unknown }): Promise<UploadState> {
    const clean = typeof meta.name === 'string' ? cleanFileName(meta.name) : null;
    if (!clean) throw new UnsupportedMediaTypeException('Поддерживаются только фото и видео (jpg, png, heic, mp4, mov и подобные)');
    const size = meta.size;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1) throw new BadRequestException('Поле size: размер файла в байтах');
    if (size > (await this.files.room(user))) throw new TooLargeError();
    const modified = typeof meta.modified === 'string' || typeof meta.modified === 'number' ? String(meta.modified).slice(0, 40) : null;

    const same = await this.db.query<UploadRow>(
      'SELECT * FROM uploads WHERE user_id = $1 AND name = $2 AND size_bytes = $3 AND modified IS NOT DISTINCT FROM $4 ORDER BY created_at LIMIT 1',
      [user.id, clean.name, size, modified],
    );
    if (same.rows[0]) {
      if ((await stat(this.storage.uploadPath(same.rows[0].id)).catch(() => null)) !== null) return this.state(same.rows[0]);
      await this.db.query('DELETE FROM uploads WHERE id = $1', [same.rows[0].id]); // файл пропал, начинаем заново
    }
    const open = Number((await this.db.query<{ n: string }>('SELECT count(*) AS n FROM uploads WHERE user_id = $1', [user.id])).rows[0].n);
    if (open >= MAX_OPEN) throw new ConflictException('Слишком много незавершённых загрузок: дождитесь окончания или отмените лишние');
    const id = randomBytes(12).toString('hex');
    await writeFile(this.storage.uploadPath(id), '', { flag: 'wx', mode: 0o600 });
    const r = await this.db.query<UploadRow>('INSERT INTO uploads (id, user_id, name, size_bytes, modified) VALUES ($1,$2,$3,$4,$5) RETURNING *', [id, user.id, clean.name, size, modified]);
    return this.state(r.rows[0]);
  }

  async status(user: UserRow, id: string): Promise<UploadState> {
    return this.state(await this.get(user, id));
  }

  // Дописывает кусок. offset должен совпасть с тем, сколько уже принято, иначе 409 с настоящим значением.
  async append(user: UserRow, id: string, offset: number, input: Readable): Promise<{ state: UploadState; file?: FileRow; duplicate?: boolean }> {
    const u = await this.get(user, id);
    if (this.locked.has(id)) throw new ConflictException('Этот кусок уже принимается');
    this.locked.add(id);
    const end = this.activity.begin();
    try {
      const total = Number(u.size_bytes);
      const have = await this.storage.uploadSize(id);
      if (offset !== have) throw new ConflictException({ message: 'Смещение не совпадает с принятым', offset: have });
      const written = await this.storage.appendChunk(id, input, Math.min(CHUNK_MAX, total - have));
      if (written === 0) throw new BadRequestException('Пустой кусок');
      await this.db.query('UPDATE uploads SET updated_at = now() WHERE id = $1', [id]);
      const now = await this.storage.uploadSize(id);
      if (now < total) return { state: await this.state(u) };
      return { state: { id, offset: now, size: total, chunk: CHUNK_HINT }, ...(await this.finish(user, u)) };
    } finally {
      end();
      this.locked.delete(id);
    }
  }

  private async finish(user: UserRow, u: UploadRow): Promise<{ file: FileRow; duplicate: boolean }> {
    const abs = this.storage.uploadPath(u.id);
    try {
      const sha = await this.storage.sha256OfAbs(abs);
      const clean = cleanFileName(u.name)!;
      return await this.files.finishUpload(user, abs, Number(u.size_bytes), sha, clean, parseTakenAt(u.modified ?? undefined, Date.now()));
    } finally {
      await rm(abs, { force: true });
      await this.db.query('DELETE FROM uploads WHERE id = $1', [u.id]);
    }
  }

  async cancel(user: UserRow, id: string): Promise<void> {
    const u = await this.get(user, id);
    if (this.locked.has(id)) throw new ConflictException('Загрузка идёт, подождите');
    await rm(this.storage.uploadPath(u.id), { force: true });
    await this.db.query('DELETE FROM uploads WHERE id = $1', [u.id]);
  }
}

export const parseOffset = (v: unknown): number => {
  if (typeof v !== 'string' || !/^\d{1,15}$/.test(v)) throw new BadRequestException('Заголовок Upload-Offset: число байт');
  return Number(v);
};
