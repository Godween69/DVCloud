import { isSupported } from './media.ts';

export interface PickedFile {
  file: File;
  path: string; // «Отпуск/День 1/IMG_1.jpg»
}

type Entry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (f: File) => void, err: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (e: Entry[]) => void, err: (e: unknown) => void) => void };
};

async function walk(entry: Entry, prefix: string, out: PickedFile[]): Promise<void> {
  if (entry.isFile && entry.file) {
    const f = await new Promise<File>((ok, err) => entry.file!(ok, err));
    out.push({ file: f, path: prefix + entry.name });
  } else if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise<Entry[]>((ok, err) => reader.readEntries(ok, err));
      if (batch.length === 0) break; // readEntries отдаёт по частям, пока не вернёт пусто
      for (const e of batch) await walk(e, prefix + entry.name + '/', out);
    }
  }
}

// Файлы из перетаскивания, включая вложенные папки.
export async function filesFromDrop(dt: DataTransfer): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  const entries: Entry[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    const e = (item as DataTransferItem & { webkitGetAsEntry?: () => Entry | null }).webkitGetAsEntry?.();
    if (e) entries.push(e);
  }
  if (entries.length === 0) return Array.from(dt.files).map((file) => ({ file, path: file.name }));
  for (const e of entries) await walk(e, '', out);
  return out;
}

// Файлы из окна выбора папки (webkitdirectory): путь лежит в webkitRelativePath.
export function filesFromInput(list: FileList | null): PickedFile[] {
  return Array.from(list ?? []).map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

export function uploadable(picked: PickedFile[]): PickedFile[] {
  return picked.filter((p) => isSupported(p.file.name) && p.file.size > 0);
}
