import { Inject, Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { PublicFile, FileRow, toPublicFile } from './files.service';
import { DEFAULT_DUP, DEFAULT_SERIES, Item, findDuplicates, findSeries, rankForQuality, rankForSeries } from './similar';

export interface SimilarFile extends PublicFile {
  width: number;
  height: number;
  sharpness: number;
  suggestRemove: boolean; // для дубликатов: предлагаем убрать; для серий: не вошёл в лучшие
}
export interface SimilarGroup {
  id: string;
  files: SimilarFile[]; // лучший первым
}

interface Row extends FileRow {
  dhash: Buffer;
  tiny: Buffer;
  width: number;
  height: number;
  sharpness: number;
}

const MAX_GROUPS = 200;

@Injectable()
export class SimilarService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  private async load(ownerId: string): Promise<{ rows: Map<string, Row>; items: Item[] }> {
    const r = await this.db.query<Row>(
      `SELECT f.*, p.dhash, p.tiny, p.width, p.height, p.sharpness
       FROM files f JOIN file_fingerprints p ON p.file_id = f.id
       WHERE f.owner_id = $1 AND f.trashed_at IS NULL`,
      [ownerId],
    );
    const rows = new Map<string, Row>();
    const items: Item[] = r.rows.map((x) => {
      rows.set(x.id, x);
      return { id: x.id, dhash: x.dhash, tiny: x.tiny, width: x.width, height: x.height, sharpness: x.sharpness, size: Number(x.size_bytes), takenAt: x.taken_at.getTime() };
    });
    return { rows, items };
  }

  private pack(rows: Map<string, Row>, ranked: Item[], keep: number): SimilarGroup {
    return {
      id: ranked.map((i) => i.id).sort((a, b) => Number(a) - Number(b))[0],
      files: ranked.map((i, n) => {
        const x = rows.get(i.id)!;
        return { ...toPublicFile(x), width: x.width, height: x.height, sharpness: Math.round(x.sharpness), suggestRemove: n >= keep };
      }),
    };
  }

  private newestFirst(groups: SimilarGroup[]): SimilarGroup[] {
    const t = (g: SimilarGroup) => Math.max(...g.files.map((f) => Date.parse(f.takenAt)));
    return groups.sort((a, b) => t(b) - t(a)).slice(0, MAX_GROUPS);
  }

  async duplicates(ownerId: string): Promise<SimilarGroup[]> {
    const { rows, items } = await this.load(ownerId);
    return this.newestFirst(findDuplicates(items, DEFAULT_DUP).map((g) => this.pack(rows, rankForQuality(g), 1)));
  }

  async series(ownerId: string): Promise<SimilarGroup[]> {
    const { rows, items } = await this.load(ownerId);
    return this.newestFirst(
      findSeries(items, DEFAULT_SERIES).map((g) => {
        const { ranked, keep } = rankForSeries(g);
        return this.pack(rows, ranked, keep);
      }),
    );
  }
}
