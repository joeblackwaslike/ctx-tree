import type { StoreBackend } from '../store/index.js';
import type { MemtreeNode, EdgeKind, Filters } from '../store/types.js';

export async function getNeighborsDeep(
  store: StoreBackend,
  nodeId: string,
  depth = 1,
  edgeKinds?: EdgeKind[],
  filters: Filters = {}
): Promise<MemtreeNode[]> {
  return store.getNeighborsDeep(nodeId, depth, edgeKinds, filters);
}
