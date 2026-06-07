import type { StoreBackend } from '../store/index.js';
import type { CtxTreeConfig } from '../store/types.js';

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function runDedupeWalker(store: StoreBackend, _config: CtxTreeConfig): Promise<void> {
  const pairs = await store.getDedupeCandidatePairs();
  if (pairs.length === 0) return;

  const now = Date.now();

  for (const pair of pairs) {
    const a = new Float32Array(pair.emb1.buffer, pair.emb1.byteOffset, pair.emb1.byteLength / 4);
    const b = new Float32Array(pair.emb2.buffer, pair.emb2.byteOffset, pair.emb2.byteLength / 4);
    const sim = cosineSimilarity(a, b);

    if (sim > 0.95) {
      const keepId = pair.ts1 >= pair.ts2 ? pair.id1 : pair.id2;
      const pruneId = pair.ts1 >= pair.ts2 ? pair.id2 : pair.id1;
      await store.markNodeStatusPruned(pruneId, now);
      await store.insertEdge({ src_id: keepId, dst_id: pruneId, kind: 'supersedes' });
    }
  }
}
