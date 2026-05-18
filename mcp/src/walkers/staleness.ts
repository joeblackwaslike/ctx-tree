import { statSync } from 'fs';
import type { Database } from 'bun:sqlite';
import type { MemtreeConfig } from '../store/types';
import { getLiveFileChunks, updateNodeStatus } from '../store/nodes';

export function runStalenessWalker(db: Database, _config: MemtreeConfig): void {
  const checkBefore = Date.now() - 5000;
  const chunks = getLiveFileChunks(db, checkBefore);

  for (const node of chunks) {
    const meta = JSON.parse(node.metadata) as { filePath?: string };
    const filePath = meta.filePath ?? node.source_uri?.replace(/^file:\/\//, '').split('#')[0];
    if (!filePath) continue;

    try {
      const stat = statSync(filePath);
      if (stat.mtimeMs !== node.mtime) {
        updateNodeStatus(db, node.id, 'stale');
      }
    } catch {
      updateNodeStatus(db, node.id, 'stale');
    }
  }
}
