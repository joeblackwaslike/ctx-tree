import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync, existsSync } from 'fs';
import { openDb, closeDb } from '../store/db';
import { insertNode } from '../store/nodes';
import { searchKeyword } from './search';
import { getNeighborsDeep } from './neighbors';
import { getPathToRoot } from './path-to-root';
import { getRecent } from './recent';
import { insertEdge } from '../store/edges';
import { wrapDatabase } from '../store/backends/sqlite/index.js';
import type { Database } from 'bun:sqlite';
import type { StoreBackend } from '../store/index.js';

const TEST_DB = '/tmp/memtree-query-test.db';
let db: Database;
let store: StoreBackend;

beforeEach(() => { db = openDb(TEST_DB); store = wrapDatabase(db); });
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
  test('finds node by keyword', async () => {
    node('n1', 'the quick brown fox jumps');
    node('n2', 'unrelated content here');
    const { nodes } = await searchKeyword(store, 'brown');
    expect(nodes.some(n => n.id === 'n1')).toBe(true);
    expect(nodes.some(n => n.id === 'n2')).toBe(false);
  });

  test('returns only live nodes by default', async () => {
    node('n3', 'live content here');
    db.run("UPDATE nodes SET status = 'stale' WHERE id = 'n3'");
    const { nodes } = await searchKeyword(store, 'live');
    expect(nodes).toHaveLength(0);
  });
});

describe('getNeighborsDeep', () => {
  test('returns edge neighbors', async () => {
    node('a', 'node a content here');
    node('b', 'node b content here');
    insertEdge(db, { src_id: 'a', dst_id: 'b', kind: 'references' });
    const neighbors = await getNeighborsDeep(store, 'a', 1);
    expect(neighbors.some(n => n.id === 'b')).toBe(true);
  });

  test('enforces MAX_DEPTH cap at 5 even when larger depth is requested', async () => {
    // Build a chain: n0 → n1 → n2 → n3 → n4 → n5 → n6 (7 hops)
    for (let i = 0; i <= 6; i++) node(`n${i}`, `chain node ${i} content long enough`);
    for (let i = 0; i < 6; i++) insertEdge(db, { src_id: `n${i}`, dst_id: `n${i + 1}`, kind: 'references' });

    const neighbors = await getNeighborsDeep(store, 'n0', 10); // request depth=10, cap is 5
    const ids = new Set(neighbors.map(n => n.id));
    // Should reach n1-n5 (5 hops) but NOT n6
    expect(ids.has('n1')).toBe(true);
    expect(ids.has('n5')).toBe(true);
    expect(ids.has('n6')).toBe(false);
  });
});

describe('getPathToRoot', () => {
  test('walks parent_id chain', async () => {
    node('root', 'root content long enough');
    node('child', 'child content long', 'root');
    node('leaf', 'leaf content long here', 'child');
    const path = await getPathToRoot(store, 'leaf');
    expect(path.map(n => n.id)).toEqual(['leaf', 'child', 'root']);
  });
});

describe('getRecent', () => {
  test('returns nodes in reverse chronological order', async () => {
    node('old', 'old content here long');
    // Force 'old' to an earlier timestamp so ordering is deterministic
    db.run('UPDATE nodes SET created_at = created_at - 1000 WHERE id = ?', 'old');
    node('new', 'new content here long');
    const nodes = await getRecent(store, undefined, 10);
    expect(nodes[0].id).toBe('new');
  });
});
