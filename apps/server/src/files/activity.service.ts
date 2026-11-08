import { Injectable } from '@nestjs/common';

// Учёт «идёт загрузка». Пока люди загружают файлы, фоновая работа (миниатюры «про запас», отпечатки для «Похожих»)
// ждёт: на небольшом сервере ядер мало, и приём файлов не должен с ней конкурировать.
// Фоновые задачи выполняются по одной, когда загрузок не было дольше паузы.
@Injectable()
export class ActivityService {
  private active = 0;
  private lastEnd = 0;
  private readonly queue: (() => Promise<void>)[] = [];
  private pumping = false;
  static readonly IDLE_MS = 3000;
  static readonly MAX_QUEUE = 5000;

  // Вызвать в начале загрузки, результат вызвать в конце (в finally).
  begin(): () => void {
    this.active++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active--;
      this.lastEnd = Date.now();
    };
  }

  busy(): boolean {
    return this.active > 0 || Date.now() - this.lastEnd < ActivityService.IDLE_MS;
  }

  // Поставить фоновую задачу. Лишние сверх лимита отбрасываются: их всё равно подберёт ночная пачка.
  defer(task: () => Promise<void>): void {
    if (this.queue.length >= ActivityService.MAX_QUEUE) return;
    this.queue.push(task);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        if (this.busy()) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        const t = this.queue.shift()!;
        try {
          await t();
        } catch {
          /* фоновая задача не должна ничего ломать */
        }
      }
    } finally {
      this.pumping = false;
    }
  }
}
