import type { Database } from 'bun:sqlite';
import type { MemtreeNode, EdgeKind, Filters } from '../store/types';
import { buildFilterSQL } from './filters';

const MAX_DEPTH = 5;

export function getNeighborsDeep(
  db: Database,
  nodeId: string,
  depth = 1,
  edgeKinds?: EdgeKind[],
  filters: Filters = {}
): MemtreeNode[] {
  const cap = Math.min(depth, MAX_DEPTH);
  const { where, params } = buildFilterSQL(filters, 'n');
  const kindFilter = edgeKinds?.length
    ? `AND e.kind IN (${edgeKinds.map(() => '?').join(',')})`
    : '';
  const kindParams = edgeKinds ?? [];

  const visited = new Set<string>([nodeId]);
  const result: MemtreeNode[] = [];
  let frontier = [nodeId];

  for (let d = 0; d < cap; d++) {
    if (frontier.length === 0) break;
    const placeholders = frontier.map(() => '?').join(',');
    const next = db.query(`
      SELECT DISTINCT n.* FROM nodes n
      JOIN edges e ON (e.src_id IN (${placeholders}) AND e.dst_id = n.id)
                   OR (e.dst_id IN (${placeholders}) AND e.src_id = n.id)
      WHERE ${where} ${kindFilter}
    `).all(...frontier, ...frontier, ...params, ...kindParams) as MemtreeNode[];

    const newNodes = next.filter(n => !visited.has(n.id));
    for (const n of newNodes) { visited.add(n.id); result.push(n); }
    frontier = newNodes.map(n => n.id);
  }

  return result;
}
