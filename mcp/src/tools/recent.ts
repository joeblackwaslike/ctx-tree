import type { Database } from 'bun:sqlite';
import type { MemtreeNode, Filters } from '../store/types';
import { buildFilterSQL } from './filters';

export function getRecent(
  db: Database,
  since?: number,
  limit = 50,
  filters: Filters = {}
): MemtreeNode[] {
  const effectiveFilters: Filters = { ...filters, ...(since ? { since } : {}) };
  const { where, params } = buildFilterSQL(effectiveFilters);
  return db.query(`
    SELECT * FROM nodes WHERE ${where} ORDER BY created_at DESC LIMIT ?
  `).all(...params, limit) as MemtreeNode[];
}
