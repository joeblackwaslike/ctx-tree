import type { StoreBackend } from '../store/index.js';
import type { CtxTreeConfig } from '../store/types.js';

const BATCH_SIZE = 50;

export async function runFilterWalker(store: StoreBackend, config: CtxTreeConfig): Promise<void> {
  const pending = await store.getPendingNodes(BATCH_SIZE);
  if (pending.length === 0) return;

  // NOTE: Each node is processed with individual store calls (pruneNode /
  // updateNodeStatus) rather than a single atomic batch. The StoreBackend
  // interface does not expose a transaction or batchFilterNodes method, so
  // atomicity across the full batch is not guaranteed. A crash mid-loop may
  // leave some nodes in 'pending'. This is a known limitation; adding a
  // batchFilterNodes method to the interface is tracked as a future improvement.
  for (const node of pending) {
    if (node.original_bytes < config.capture.filterMinSize) {
      await store.pruneNode(node.id);
      continue;
    }
    const existing = await store.getNodeByContentHash(node.content_hash);
    if (existing && existing.id !== node.id && existing.status === 'live') {
      await store.pruneNode(node.id);
      continue;
    }
    await store.updateNodeStatus(node.id, 'live');
  }
}
