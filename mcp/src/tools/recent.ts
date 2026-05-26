import type { Database } from 'bun:sqlite';
import type { MemtreeNode, Filters, NodeKind } from '../store/types';
import { buildFilterSQL } from './filters';

const CONTENT_KINDS: NodeKind[] = [
  'file_chunk', 'tool_output', 'summary', 'note', 'observation', 'web_chunk',
];

export function getRecent(
  db: Database,
  since?: number,
  limit = 50,
  filters: Filters = {}
): MemtreeNode[] {
  const effectiveFilters: Filters = {
    // Exclude session nodes by default — callers pass filters.kind explicitly to override
    kind: CONTENT_KINDS,
    ...filters,
    ...(since ? { since } : {}),
  };
  const { where, params } = buildFilterSQL(effectiveFilters);
  return db.query(`
    SELECT * FROM nodes WHERE ${where} ORDER BY created_at DESC LIMIT ?
  `).all(...params, limit) as MemtreeNode[];
}
