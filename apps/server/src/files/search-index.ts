import { DbService } from '../db/db.service';

export interface IndexStats {
  total: number; // файлов (картинок и видео), которые должны попасть в поиск
  ready: number;
  failed: number;
  pending: number;
}

// Сколько физических файлов уже имеют вектор текущей модели. Считаем по blobs: одно содержимое индексируется один раз.
// Файлы, которые лежат только в корзине, не считаются: вернутся из корзины, тогда и посчитаются.
export async function indexStats(db: DbService, model: string | null): Promise<IndexStats> {
  const r = await db.query<{ total: string; ready: string; failed: string }>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE e.status = 'ready' AND e.model = $1) AS ready,
            count(*) FILTER (WHERE e.status = 'failed' AND e.model = $1) AS failed
     FROM blobs b LEFT JOIN embeddings e ON e.blob_id = b.id
     WHERE (b.mime LIKE 'image/%' OR b.mime LIKE 'video/%') AND EXISTS (SELECT 1 FROM files f WHERE f.blob_id = b.id AND f.trashed_at IS NULL)`,
    [model],
  );
  const x = r.rows[0];
  const total = Number(x.total);
  const ready = Number(x.ready);
  const failed = Number(x.failed);
  return { total, ready, failed, pending: total - ready - failed };
}
