import type { StoreBackend } from '../store/index.js';
import type { MemtreeConfig } from '../store/types.js';

export async function runPrunerWalker(store: StoreBackend, config: MemtreeConfig): Promise<void> {
  const now = Date.now();
  const staleThreshold = now - config.retention.staleHours * 60 * 60 * 1000;
  const supersededThreshold = now - config.retention.supersededDays * 24 * 60 * 60 * 1000;

  for (const node of await store.getStaleNodes(staleThreshold)) {
    await store.pruneNode(node.id);
  }
  for (const node of await store.getSupersededNodes(supersededThreshold)) {
    await store.pruneNode(node.id);
  }
}
