import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync, existsSync } from 'fs';
import { openDb, closeDb } from './db';
import { insertNode, getNode, updateNodeStatus, getNodeBySourceUri,
         getNodeByContentHash, listChildren } from './nodes';
import { insertEdge, getNeighbors } from './edges';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';

const TEST_DB = '/tmp/memtree-nodes-test.db';
let db: Database;

beforeEach(() => { db = openDb(TEST_DB); });
afterEach(() => {
  closeDb(db);
  for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm'])
    if (existsSync(f)) unlinkSync(f);
});

function makeNode(overrides: Partial<Parameters<typeof insertNode>[1]> = {}) {
  return {
    parent_id: null, kind: 'note' as const, source_uri: null,
    content: 'test content', content_hash: 'abc123',
    status: 'live' as const, mtime: 0,
    truncated: 0, original_bytes: 12, metadata: '{}',
    ...overrides,
  };
}

describe('nodes', () => {
  test('insertNode and getNode round-trip', () => {
    const id = ulid();
    insertNode(db, id, makeNode());
    const node = getNode(db, id);
    expect(node).not.toBeNull();
    expect(node!.content).toBe('test content');
    expect(node!.status).toBe('live');
  });

  test('updateNodeStatus transitions status', () => {
    const id = ulid();
    insertNode(db, id, makeNode({ status: 'pending' }));
    updateNodeStatus(db, id, 'live');
    expect(getNode(db, id)!.status).toBe('live');
  });

  test('getNodeBySourceUri finds node', () => {
    const id = ulid();
    insertNode(db, id, makeNode({ source_uri: 'file:///foo/bar.ts#L1-20' }));
    const found = getNodeBySourceUri(db, 'file:///foo/bar.ts#L1-20');
    expect(found?.id).toBe(id);
  });

  test('getNodeByContentHash finds node', () => {
    const id = ulid();
    insertNode(db, id, makeNode({ content_hash: 'dedup-hash-xyz' }));
    const found = getNodeByContentHash(db, 'dedup-hash-xyz');
    expect(found?.id).toBe(id);
  });

  test('listChildren returns direct children', () => {
    const parentId = ulid();
    insertNode(db, parentId, makeNode());
    const childId = ulid();
    insertNode(db, childId, makeNode({ parent_id: parentId }));
    const children = listChildren(db, parentId);
    expect(children).toHaveLength(1);
    expect(children[0].id).toBe(childId);
  });
});

describe('edges', () => {
  test('insertEdge and getNeighbors', () => {
    const a = ulid(), b = ulid();
    insertNode(db, a, makeNode());
    insertNode(db, b, makeNode());
    insertEdge(db, { src_id: a, dst_id: b, kind: 'references' });
    const neighbors = getNeighbors(db, a);
    expect(neighbors.some(n => n.id === b)).toBe(true);
  });

  test('getNeighbors is bidirectional — querying dst also returns src', () => {
    const a = ulid(), b = ulid();
    insertNode(db, a, makeNode());
    insertNode(db, b, makeNode());
    insertEdge(db, { src_id: a, dst_id: b, kind: 'references' });
    const neighborsOfB = getNeighbors(db, b);
    expect(neighborsOfB.some(n => n.id === a)).toBe(true);
  });
});
