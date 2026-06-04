import type { StoreBackend } from '../store/index.js';
import type { CtxTreeConfig, SummarizerProvider } from '../store/types.js';

const CHAR_THRESHOLD_MULTIPLIER = 20;

// module-level flag: only one batch runs at a time per process
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
      // Do NOT reset inFlight here — let .finally() handle it uniformly
      return Promise.resolve();
    }
    const promises = rows.map(row =>
      provider.summarize(row.content, row.source_uri ?? undefined)
        .then(summary => store.updateNodeSummary(row.id, summary))
        .catch((e: unknown) => {
          process.stderr.write(`ctx-tree summarizer error: ${e}\n`);
        })
    );
    return Promise.all(promises);
  }).catch((e: unknown) => {
    process.stderr.write(`ctx-tree summarizer error: ${e}\n`);
  }).finally(() => {
    inFlight = false;
  });
}
