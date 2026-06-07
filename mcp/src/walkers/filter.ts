import type { StoreBackend } from '../store/index.js';
import type { CtxTreeConfig } from '../store/types.js';

const BATCH_SIZE = 50;

export async function runFilterWalker(store: StoreBackend, config: CtxTreeConfig): Promise<void> {
  const pending = await store.getPendingNodes(BATCH_SIZE);
  if (pending.length === 0) return;

  const decisions: Array<{ id: string; action: 'prune' | 'promote' }> = [];


  for (const node of pending) {
    if (node.original_bytes < config.capture.filterMinSize) {
      decisions.push({ id: node.id, action: 'prune' });
      continue;
    }
    const existing = await store.getNodeByContentHash(node.content_hash);
    if (existing && existing.id !== node.id && existing.status === 'live') {
      decisions.push({ id: node.id, action: 'prune' });
      continue;
    }
    decisions.push({ id: node.id, action: 'promote' });
  }

  await store.atomicBatchFilter(decisions);
}
