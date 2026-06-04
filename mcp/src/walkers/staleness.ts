import { statSync } from 'fs';
import type { StoreBackend } from '../store/index.js';
import type { CtxTreeConfig } from '../store/types.js';

export async function runStalenessWalker(store: StoreBackend, _config: CtxTreeConfig): Promise<void> {
  const checkBefore = Date.now() - 5000;
  const chunks = await store.getLiveFileChunks(checkBefore);

  for (const node of chunks) {
    const meta = JSON.parse(node.metadata) as { filePath?: string };
    const filePath = meta.filePath ?? node.source_uri?.replace(/^file:\/\//, '').split('#')[0];
    if (!filePath) continue;

    try {
      const stat = statSync(filePath);
      if (Math.round(stat.mtimeMs) !== node.mtime) {
        await store.updateNodeStatus(node.id, 'stale');
      }
    } catch {
      await store.updateNodeStatus(node.id, 'stale');
    }
  }
}
