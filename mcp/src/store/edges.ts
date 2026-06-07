import type { Database } from 'bun:sqlite';
import type { CtxTreeEdge, EdgeKind, CtxTreeNode } from './types';

export function insertEdge(db: Database, edge: Omit<CtxTreeEdge, 'created_at'>): void {
  db.run(
    `INSERT OR IGNORE INTO edges (src_id, dst_id, kind, created_at) VALUES (?, ?, ?, ?)`,
    edge.src_id, edge.dst_id, edge.kind, Date.now()
  );
}

export function getNeighbors(
  db: Database,
  nodeId: string,
  edgeKinds?: EdgeKind[]
): CtxTreeNode[] {
  const kindFilter = edgeKinds?.length
    ? `AND e.kind IN (${edgeKinds.map(() => '?').join(',')})`
    : '';
  const params = edgeKinds?.length
    ? [nodeId, nodeId, ...edgeKinds]
    : [nodeId, nodeId];
  return db.query(`
    SELECT DISTINCT n.* FROM nodes n
    JOIN edges e ON (e.src_id = ? AND e.dst_id = n.id)
                 OR (e.dst_id = ? AND e.src_id = n.id)
    WHERE n.status = 'live' ${kindFilter}
  `).all(...params) as CtxTreeNode[];
}

export function getEdgesFrom(db: Database, srcId: string): CtxTreeEdge[] {
  return db.query('SELECT * FROM edges WHERE src_id = ?').all(srcId) as CtxTreeEdge[];
}
