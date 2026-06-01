import type { StoreBackend } from '../store/index.js';
import type { MemtreeNode, Filters, NodeKind } from '../store/types.js';

const CONTENT_KINDS: NodeKind[] = [
  'file_chunk', 'tool_output', 'summary', 'note', 'observation', 'web_chunk',
];

export async function getRecent(
  store: StoreBackend,
  since?: number,
  limit = 50,
  filters: Filters = {}
): Promise<MemtreeNode[]> {
  return store.getRecentNodes(since, limit, {
    kind: CONTENT_KINDS,
    ...filters,
  });
}
