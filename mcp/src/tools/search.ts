import type { Database } from 'bun:sqlite';
import type { MemtreeNode, Filters } from '../store/types';
import { buildFilterSQL } from './filters';

export interface SearchResult {
  nodes: MemtreeNode[];
}

export function searchKeyword(
  db: Database,
  query: string,
  limit = 20,
  filters: Filters = {}
): SearchResult {
  const { where, params } = buildFilterSQL(filters);
  const nodes = db.query(`
    SELECT n.* FROM nodes n
    JOIN nodes_fts f ON f.id = n.id
    WHERE nodes_fts MATCH ? AND ${where}
    ORDER BY rank
    LIMIT ?
  `).all(query, ...params, limit) as MemtreeNode[];
  return { nodes };
}
