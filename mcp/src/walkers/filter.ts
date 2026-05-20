import type { Database } from 'bun:sqlite';
import type { MemtreeConfig } from '../store/types';
import { getPendingNodes, updateNodeStatus, pruneNode } from '../store/nodes';

const BATCH_SIZE = 50;

export function runFilterWalker(db: Database, config: MemtreeConfig): void {
  const pending = getPendingNodes(db, BATCH_SIZE);
  if (pending.length === 0) return;

  const processBatch = db.transaction(() => {
    for (const node of pending) {
      if (node.original_bytes < config.capture.filterMinSize) {
        pruneNode(db, node.id);
        continue;
      }
      const existing = db.query(
        "SELECT id FROM nodes WHERE content_hash = ? AND status = 'live' AND id != ? LIMIT 1"
      ).get(node.content_hash, node.id);
      if (existing) {
        pruneNode(db, node.id);
        continue;
      }
      updateNodeStatus(db, node.id, 'live');
    }
  });
  processBatch();
}
