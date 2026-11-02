import type { FileItem } from '../types.ts';
import { isSupported } from './media.ts';

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'duplicate' | 'error';

export interface UploadJob {
  id: number;
  name: string;
  size: number;
  status: UploadStatus;
  progress: number; // 0..1
  error?: string;
}

export interface Uploadable {
  name: string;
  size: number;
  lastModified: number;
}

// Отправка одного файла: возвращает HTTP-статус и тело ответа. Для сети это XHR, в тестах подставка.
export type Sender<F extends Uploadable> = (file: F, onProgress: (fraction: number) => void) => Promise<{ status: number; json: any }>;

// Очередь загрузок: одновременно не больше N файлов, у каждого свой статус и прогресс.
export class UploadQueue<F extends Uploadable> {
  private jobs: UploadJob[] = [];
  private waiting: { job: UploadJob; file: F }[] = [];
  private active = 0;
  private nextId = 1;
  private send: Sender<F>;
  private onChange: (jobs: UploadJob[]) => void;
  private onUploaded: (file: FileItem, duplicate: boolean) => void;
  private concurrency: number;

  constructor(send: Sender<F>, onChange: (jobs: UploadJob[]) => void, onUploaded: (file: FileItem, duplicate: boolean) => void, concurrency = 2) {
    this.send = send;
    this.onChange = onChange;
    this.onUploaded = onUploaded;
    this.concurrency = concurrency;
  }

  add(files: F[]): void {
    for (const file of files) {
      const job: UploadJob = { id: this.nextId++, name: file.name, size: file.size, status: 'queued', progress: 0 };
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
    this.jobs = this.jobs.filter((j) => j.status === 'queued' || j.status === 'uploading');
    this.emit();
  }

  private emit(): void {
    this.onChange(this.jobs.map((j) => ({ ...j })));
  }

  private pump(): void {
    while (this.active < this.concurrency && this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      this.active++;
      void this.run(next.job, next.file);
    }
  }

  private async run(job: UploadJob, file: F): Promise<void> {
    job.status = 'uploading';
    this.emit();
    try {
      const r = await this.send(file, (p) => {
        job.progress = p;
        this.emit();
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
