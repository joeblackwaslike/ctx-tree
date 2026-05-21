import type { Database } from 'bun:sqlite';
import type { MemtreeConfig } from '../store/types.js';
import { insertEdge } from '../store/edges.js';

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

interface CandidatePair {
  id1: string;
  id2: string;
  emb1: Uint8Array;
  emb2: Uint8Array;
  ts1: number;
  ts2: number;
}

export function runDedupeWalker(db: Database, _config: MemtreeConfig): void {
  const pairs = db.query<CandidatePair, []>(`
    SELECT n1.id as id1, n2.id as id2,
           v1.embedding as emb1, v2.embedding as emb2,
           n1.created_at as ts1, n2.created_at as ts2
    FROM nodes n1
    JOIN nodes n2 ON n1.source_uri = n2.source_uri AND n1.id < n2.id
    JOIN nodes_vec v1 ON n1.id = v1.id
    JOIN nodes_vec v2 ON n2.id = v2.id
    WHERE n1.kind = 'file_chunk'
      AND n2.kind = 'file_chunk'
      AND n1.status = 'live'
      AND n2.status = 'live'
      AND v1.embedding_model = v2.embedding_model
    LIMIT 50
  `).all();

  if (pairs.length === 0) return;

  const now = Date.now();

  db.transaction(() => {
    for (const pair of pairs) {
      const a = new Float32Array(pair.emb1.buffer, pair.emb1.byteOffset, pair.emb1.byteLength / 4);
      const b = new Float32Array(pair.emb2.buffer, pair.emb2.byteOffset, pair.emb2.byteLength / 4);
      const sim = cosineSimilarity(a, b);

      if (sim > 0.95) {
        // Keep newer node (higher created_at), prune older
        const keepId = pair.ts1 >= pair.ts2 ? pair.id1 : pair.id2;
        const pruneId = pair.ts1 >= pair.ts2 ? pair.id2 : pair.id1;

        db.run(`UPDATE nodes SET status='pruned', updated_at=? WHERE id=?`, now, pruneId);
        insertEdge(db, { src_id: keepId, dst_id: pruneId, kind: 'supersedes' });
      }
    }
  })();
}
