import type { Database } from 'bun:sqlite';
import type { MemtreeConfig } from '../store/types.js';
import type { EmbeddingProvider } from '../store/types.js';

export function runEmbeddingWalker(
  db: Database,
  config: MemtreeConfig,
  provider: EmbeddingProvider | null
): void {
  if (!provider) return;

  const batchSize = config.walkers.embeddingBatchSize;

  const rows = db.query<{ id: string; content: string }, [number]>(`
    SELECT n.id, n.content FROM nodes n
    LEFT JOIN nodes_vec v ON n.id = v.id
    WHERE n.status = 'live'
      AND v.id IS NULL
      AND length(n.content) > 0
    LIMIT ?
  `).all(batchSize);

  if (rows.length === 0) return;

  const texts = rows.map(r => r.content);

  provider.embed(texts).then(vectors => {
    const now = Date.now();
    const upsert = db.prepare(`
      INSERT OR REPLACE INTO nodes_vec (id, embedding, embedding_model, embedding_dim, embedded_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertBatch = db.transaction(() => {
      for (let i = 0; i < rows.length; i++) {
        const vec = vectors[i];
        const blob = Buffer.from(new Float32Array(vec).buffer);
        upsert.run(rows[i].id, blob, provider.model, vec.length, now);
      }
    });
    insertBatch();
  }).catch((e: unknown) => {
    process.stderr.write(`memtree embedding error: ${e}\n`);
  });
}
