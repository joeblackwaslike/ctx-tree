import type { Database } from 'bun:sqlite';
import type { MemtreeNode } from '../store/types';

export function getPathToRoot(db: Database, nodeId: string): MemtreeNode[] {
  const path: MemtreeNode[] = [];
  let current = db.query('SELECT * FROM nodes WHERE id = ?').get(nodeId) as MemtreeNode | undefined;

  while (current) {
    path.push(current);
    if (!current.parent_id) break;
    current = db.query('SELECT * FROM nodes WHERE id = ?').get(current.parent_id) as MemtreeNode | undefined;
  }

  return path;
}
