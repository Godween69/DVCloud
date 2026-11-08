import type { ClaimResult, FileItem } from '../types.ts';
import { isSupported } from './media.ts';

export type UploadStatus = 'queued' | 'checking' | 'uploading' | 'done' | 'linked' | 'duplicate' | 'error';

export interface UploadJob {
  id: number;
  name: string;
  path: string; // с папкой, если файл выбран вместе с папкой
  size: number;
  status: UploadStatus;
  progress: number; // 0..1
  error?: string;
}

export interface Uploadable {
  name: string;
  size: number;
  lastModified: number;
  path?: string;
}

// Отправка одного файла: возвращает HTTP-статус и тело ответа. Для сети это XHR (с докачкой для больших), в тестах подставка.
export type Sender<F extends Uploadable> = (file: F, onProgress: (fraction: number) => void) => Promise<{ status: number; json: any }>;

// Проверка «такой файл уже есть в облаке?»: считает хеш и спрашивает сервер. null: проверить нельзя (файл слишком велик, нет доступа к хешу),
// тогда файл просто загружается.
export type Claimer<F extends Uploadable> = (file: F) => Promise<ClaimResult | null>;

export const MAX_HASH_BYTES = 128 * 1024 * 1024;

export interface QueueStats {
  total: number;
  finished: number;
  failed: number;
  bytesTotal: number;
  bytesDone: number;
}

// Очередь загрузок: одновременно не больше N файлов, у каждого свой статус и прогресс.
// Файл сначала сверяется по хешу: если он уже лежит в облаке, дальше записывается только ссылка и по сети ничего не идёт.
export class UploadQueue<F extends Uploadable> {
  private jobs: UploadJob[] = [];
  private waiting: { job: UploadJob; file: F }[] = [];
  private active = 0;
  private nextId = 1;
  private paused = false;

  private send: Sender<F>;
  private onChange: (jobs: UploadJob[]) => void;
  private onUploaded: (file: FileItem, duplicate: boolean) => void;
  private concurrency: number;
  private claim?: Claimer<F>;

  constructor(send: Sender<F>, onChange: (jobs: UploadJob[]) => void, onUploaded: (file: FileItem, duplicate: boolean) => void, concurrency = 3, claim?: Claimer<F>) {
    this.send = send;
    this.onChange = onChange;
    this.onUploaded = onUploaded;
    this.concurrency = concurrency;
    this.claim = claim;
  }

  add(files: F[]): void {
    for (const file of files) {
      const job: UploadJob = { id: this.nextId++, name: file.name, path: file.path || file.name, size: file.size, status: 'queued', progress: 0 };
      this.jobs.push(job);
      if (!isSupported(file.name)) {
        job.status = 'error';
        job.error = 'Это не фото и не видео';
      } else if (file.size === 0) {
        job.status = 'error';
        job.error = 'Файл пустой';
      } else {
        this.waiting.push({ job, file });
      }
    }
    this.emit();
    this.pump();
  }

  // Убирает из списка всё, что уже закончилось (успешно или с ошибкой).
  clearFinished(): void {
    this.jobs = this.jobs.filter((j) => j.status === 'queued' || j.status === 'checking' || j.status === 'uploading');
    this.emit();
  }

  // Убирает ожидающие файлы (то, что ещё не начало грузиться).
  cancelWaiting(): void {
    for (const w of this.waiting) {
      w.job.status = 'error';
      w.job.error = 'Отменено';
    }
    this.waiting = [];
    this.emit();
  }

  pending(): number {
    return this.waiting.length + this.active;
  }

  // Повторить все файлы с ошибкой (кроме «не фото» и «пустой»): файлы запоминаем отдельно.
  private files = new Map<number, F>();
  retryFailed(): void {
    for (const j of this.jobs) {
      const f = this.files.get(j.id);
      if (j.status === 'error' && f && j.error !== 'Отменено') {
        j.status = 'queued';
        j.error = undefined;
        j.progress = 0;
        this.waiting.push({ job: j, file: f });
      }
    }
    this.emit();
    this.pump();
  }

  private emit(): void {
    this.onChange(this.jobs.map((j) => ({ ...j })));
  }

  private lastEmit = 0;
  private emitSoon(): void {
    const now = Date.now();
    if (now - this.lastEmit < 120) return;
    this.lastEmit = now;
    this.emit();
  }

  private pump(): void {
    while (!this.paused && this.active < this.concurrency && this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      this.files.set(next.job.id, next.file);
      this.active++;
      void this.run(next.job, next.file);
    }
  }

  private async run(job: UploadJob, file: F): Promise<void> {
    try {
      if (this.claim && file.size <= MAX_HASH_BYTES) {
        job.status = 'checking';
        this.emit();
        let c: ClaimResult | null = null;
        try {
          c = await this.claim(file);
        } catch {
          c = null; // сверка не получилась (сеть, нет хеша): грузим как обычно
        }
        if (c && (c.state === 'linked' || c.state === 'restored') && c.file) {
          job.status = 'linked';
          job.progress = 1;
          this.onUploaded(c.file, false);
          return;
        }
        if (c && c.state === 'mine') {
          job.status = 'duplicate';
          job.progress = 1;
          if (c.file) this.onUploaded(c.file, true);
          return;
        }
        if (c && c.state === 'quota') {
          job.status = 'error';
          job.error = 'Не хватает места в вашей квоте';
          return;
        }
      }
      job.status = 'uploading';
      this.emit();
      const r = await this.send(file, (p) => {
        job.progress = p;
        this.emitSoon();
      });
      if (r.status === 201 || r.status === 200) {
        const dup = r.status === 200 && r.json?.duplicate === true;
        job.status = dup ? 'duplicate' : 'done';
        job.progress = 1;
        this.onUploaded(r.json.file as FileItem, dup);
      } else {
        job.status = 'error';
        job.error = typeof r.json?.message === 'string' ? r.json.message : `Ошибка сервера (${r.status})`;
      }
    } catch (e) {
      job.status = 'error';
      job.error = e instanceof Error ? e.message : 'Не удалось загрузить';
    } finally {
      this.active--;
      this.emit();
      this.pump();
    }
  }
}

export function queueStats(jobs: UploadJob[]): QueueStats {
  let finished = 0;
  let failed = 0;
  let bytesTotal = 0;
  let bytesDone = 0;
  for (const j of jobs) {
    bytesTotal += j.size;
    const fin = j.status === 'done' || j.status === 'linked' || j.status === 'duplicate' || j.status === 'error';
    if (fin) finished++;
    if (j.status === 'error') failed++;
    bytesDone += fin ? j.size : j.size * j.progress;
  }
  return { total: jobs.length, finished, failed, bytesTotal, bytesDone };
}
