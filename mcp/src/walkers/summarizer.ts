import type { StoreBackend } from '../store/index.js';
import type { CtxTreeConfig, SummarizerProvider } from '../store/types.js';

const CHAR_THRESHOLD_MULTIPLIER = 20;

let inFlight = false;

export function runSummarizerWalker(
  store: StoreBackend,
  config: CtxTreeConfig,
  provider: SummarizerProvider | null
): void {
  if (!provider) return;
  if (inFlight) return;

  const charThreshold = Math.max(
    500,
    config.walkers.summarizerSubtreeThreshold * CHAR_THRESHOLD_MULTIPLIER
  );
  const batchSize = 10;

  inFlight = true;
  store.getNodesNeedingSummarization(charThreshold, batchSize).then(rows => {
    if (rows.length === 0) {
      inFlight = false;
      return;
    }
    let pending = rows.length;

    for (const row of rows) {
      provider.summarize(row.content, row.source_uri ?? undefined).then(summary => {
        return store.updateNodeSummary(row.id, summary);
      }).catch((e: unknown) => {
        process.stderr.write(`ctx-tree summarizer error: ${e}\n`);
      }).finally(() => {
        pending--;
        if (pending === 0) inFlight = false;
      });
    }
  }).catch((e: unknown) => {
    inFlight = false;
    process.stderr.write(`ctx-tree summarizer error: ${e}\n`);
  });
}
