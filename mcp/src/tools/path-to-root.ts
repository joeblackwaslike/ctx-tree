import type { StoreBackend } from '../store/index.js';
import type { CtxTreeNode } from '../store/types.js';

export async function getPathToRoot(store: StoreBackend, nodeId: string): Promise<CtxTreeNode[]> {
  return store.getPathToRoot(nodeId);
}
