import type { StoreBackend } from '../store/index.js';
import type { CtxTreeConfig } from '../store/types.js';

/** Returns cosine similarity in [−1, 1]; returns 0 for incompatible vectors (different lengths, zero magnitude, or non-finite denominator). */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (!isFinite(denom) || denom === 0) return 0;
  return dot / denom;
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
      await store.atomicPruneAndSupersede(pruneId, keepId, now);
    }
  }
}
