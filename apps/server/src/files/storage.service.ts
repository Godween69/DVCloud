import { Inject, Injectable, OnModuleInit, PayloadTooLargeException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, mkdir, readdir, rm, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Config } from '../config';
import { CONFIG } from '../tokens';
import { withSuffix } from './names';

export class TooLargeError extends PayloadTooLargeException {
  constructor() {
    super('Файл больше допустимого размера или квоты');
  }
}

// Работа с диском. Все пути строятся сервером из логина и id, имена от клиента сюда попадают только очищенными.
@Injectable()
export class StorageService implements OnModuleInit {
  readonly root: string;

  constructor(@Inject(CONFIG) cfg: Config) {
    this.root = resolve(cfg.dataDir);
  }

  async onModuleInit(): Promise<void> {
    for (const d of ['library', 'trash', 'tmp']) await mkdir(join(this.root, d), { recursive: true });
    // Недогруженные куски после падения или обрыва не нужны.
    for (const f of await readdir(join(this.root, 'tmp'))) await rm(join(this.root, 'tmp', f), { force: true });
  }

  // Абсолютный путь по относительному; выход за каталог данных запрещён.
  abs(rel: string): string {
    const p = resolve(this.root, rel);
    if (!p.startsWith(this.root + sep)) throw new Error('Путь вне каталога данных');
    return p;
  }

  newTmp(): string {
    return join(this.root, 'tmp', randomBytes(12).toString('hex'));
  }

  // Принимает поток в временный файл, считая размер и SHA-256. Память не растёт: данные идут кусками.
  async receive(input: Readable, tmpAbs: string, maxBytes: number): Promise<{ size: number; sha256: string }> {
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) return cb(new TooLargeError());
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(input, meter, createWriteStream(tmpAbs, { flags: 'wx', mode: 0o600 }));
    } catch (e) {
      await rm(tmpAbs, { force: true });
      throw e;
    }
    return { size, sha256: hash.digest('hex') };
  }

  // Кладёт файл в папку под свободным именем (без перезаписи) и убирает исходный. Возвращает путь внутри данных.
  async placeUnique(srcAbs: string, dirRel: string, name: { stem: string; ext: string }, prefix = ''): Promise<string> {
    await mkdir(this.abs(dirRel), { recursive: true });
    for (let n = 1; n < 10000; n++) {
      const rel = `${dirRel}/${prefix}${withSuffix(name, n)}`;
      try {
        await link(srcAbs, this.abs(rel)); // link не перезаписывает существующий файл
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw e;
      }
      await unlink(srcAbs);
      return rel;
    }
    throw new Error('Не удалось подобрать имя файла');
  }

  // Возвращает файл на точно указанное место (откат при сбое базы). Существующий файл не затирает.
  async moveExact(fromRel: string, toRel: string): Promise<void> {
    await mkdir(dirname(this.abs(toRel)), { recursive: true });
    await link(this.abs(fromRel), this.abs(toRel));
    await unlink(this.abs(fromRel));
  }

  async remove(rel: string): Promise<void> {
    await rm(this.abs(rel), { force: true });
  }
}
