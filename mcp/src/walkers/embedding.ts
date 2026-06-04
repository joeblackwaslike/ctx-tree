import type { StoreBackend } from '../store/index.js';
import type { CtxTreeConfig, EmbeddingProvider } from '../store/types.js';

let inFlight = false;

export function runEmbeddingWalker(
  store: StoreBackend,
  config: CtxTreeConfig,
  provider: EmbeddingProvider | null
): void {
  if (!provider) return;
  if (inFlight) return;

  const batchSize = config.walkers.embeddingBatchSize;

  store.getPendingEmbeddingNodes(batchSize).then(rows => {
    if (rows.length === 0) return;
    inFlight = true;
    const texts = rows.map(r => r.content);

    return provider.embed(texts).then(vectors => {
      const now = Date.now();
      const upsertRows = rows.map((row, i) => ({
        id: row.id,
        embedding: Buffer.from(new Float32Array(vectors[i]).buffer),
        model: provider.model,
        dim: vectors[i].length,
        embeddedAt: now,
      }));
      return store.batchUpsertNodeVec(upsertRows);
    });
  }).catch((e: unknown) => {
    process.stderr.write(`ctx-tree embedding error: ${e}\n`);
  }).finally(() => {
    inFlight = false;
  });
}
