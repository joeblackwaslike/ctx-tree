import type { Database } from 'bun:sqlite';
import type { MemtreeConfig } from '../store/types';
import { getStaleNodes, getSupersededNodes, pruneNode } from '../store/nodes';

export function runPrunerWalker(db: Database, config: MemtreeConfig): void {
  const now = Date.now();
  const staleThreshold = now - config.retention.staleHours * 60 * 60 * 1000;
  const supersededThreshold = now - config.retention.supersededDays * 24 * 60 * 60 * 1000;

  for (const node of getStaleNodes(db, staleThreshold)) {
    pruneNode(db, node.id);
  }
  for (const node of getSupersededNodes(db, supersededThreshold)) {
    pruneNode(db, node.id);
  }
}
