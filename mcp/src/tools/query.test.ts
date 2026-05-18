import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync, existsSync } from 'fs';
import { openDb, closeDb } from '../store/db';
import { insertNode } from '../store/nodes';
import { searchKeyword } from './search';
import { getNeighborsDeep } from './neighbors';
import { getPathToRoot } from './path-to-root';
import { getRecent } from './recent';
import { insertEdge } from '../store/edges';
import type { Database } from 'bun:sqlite';

const TEST_DB = '/tmp/memtree-query-test.db';
let db: Database;

beforeEach(() => { db = openDb(TEST_DB); });
afterEach(() => {
  closeDb(db);
  for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm'])
    if (existsSync(f)) unlinkSync(f);
});

function node(id: string, content: string, parentId: string | null = null) {
  insertNode(db, id, {
    parent_id: parentId, kind: 'note', source_uri: null,
    content, content_hash: id, status: 'live',
    mtime: 0, truncated: 0, original_bytes: content.length, metadata: '{}',
  });
}

describe('searchKeyword', () => {
  test('finds node by keyword', () => {
    node('n1', 'the quick brown fox jumps');
    node('n2', 'unrelated content here');
    const { nodes } = searchKeyword(db, 'brown');
    expect(nodes.some(n => n.id === 'n1')).toBe(true);
    expect(nodes.some(n => n.id === 'n2')).toBe(false);
  });

  test('returns only live nodes by default', () => {
    node('n3', 'live content here');
    db.run("UPDATE nodes SET status = 'stale' WHERE id = 'n3'");
    const { nodes } = searchKeyword(db, 'live');
    expect(nodes).toHaveLength(0);
  });
});

describe('getNeighborsDeep', () => {
  test('returns edge neighbors', () => {
    node('a', 'node a content here');
    node('b', 'node b content here');
    insertEdge(db, { src_id: 'a', dst_id: 'b', kind: 'references' });
    const neighbors = getNeighborsDeep(db, 'a', 1);
    expect(neighbors.some(n => n.id === 'b')).toBe(true);
  });
});

describe('getPathToRoot', () => {
  test('walks parent_id chain', () => {
    node('root', 'root content long enough');
    node('child', 'child content long', 'root');
    node('leaf', 'leaf content long here', 'child');
    const path = getPathToRoot(db, 'leaf');
    expect(path.map(n => n.id)).toEqual(['leaf', 'child', 'root']);
  });
});

describe('getRecent', () => {
  test('returns nodes in reverse chronological order', () => {
    node('old', 'old content here long');
    // Force 'old' to an earlier timestamp so ordering is deterministic
    db.run('UPDATE nodes SET created_at = created_at - 1000 WHERE id = ?', 'old');
    node('new', 'new content here long');
    const nodes = getRecent(db, undefined, 10);
    expect(nodes[0].id).toBe('new');
  });
});
