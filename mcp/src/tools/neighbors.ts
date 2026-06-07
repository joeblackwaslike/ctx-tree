import type { StoreBackend } from '../store/index.js';
import type { CtxTreeNode, EdgeKind, Filters } from '../store/types.js';

export async function getNeighborsDeep(
  store: StoreBackend,
  nodeId: string,
  depth = 1,
  edgeKinds?: EdgeKind[],
  filters: Filters = {}
): Promise<CtxTreeNode[]> {
  return store.getNeighborsDeep(nodeId, depth, edgeKinds, filters);
}
