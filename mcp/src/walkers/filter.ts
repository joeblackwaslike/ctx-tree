import type { StoreBackend } from '../store/index.js';
import type { CtxTreeConfig } from '../store/types.js';

const BATCH_SIZE = 50;

export async function runFilterWalker(store: StoreBackend, config: CtxTreeConfig): Promise<void> {
  const pending = await store.getPendingNodes(BATCH_SIZE);
  if (pending.length === 0) return;

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
