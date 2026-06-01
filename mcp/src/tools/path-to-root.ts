import type { StoreBackend } from '../store/index.js';
import type { MemtreeNode } from '../store/types.js';

export async function getPathToRoot(store: StoreBackend, nodeId: string): Promise<MemtreeNode[]> {
  return store.getPathToRoot(nodeId);
}
