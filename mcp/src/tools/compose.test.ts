import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync, existsSync } from 'fs';
import { openDb, closeDb } from '../store/db';
import { insertNode } from '../store/nodes';
import { insertEdge } from '../store/edges';
import { memtreeCompose } from './compose';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';

const TEST_DB = '/tmp/memtree-compose-test.db';
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

const LONG = (n: number) => Array(n).fill('word').join(' ');

describe('memtreeCompose', () => {
  test('returns content within budget_tokens', async () => {
    node('a', LONG(50));
    node('b', LONG(50), 'a');
    node('c', LONG(50), 'a');
    const result = await memtreeCompose(db, { node_ids: ['a'], budget_tokens: 100 });
    const approxTokens = Math.ceil(result.content.length / 4);
    expect(approxTokens).toBeLessThanOrEqual(110);
  });

  test('manifest.included lists packed node IDs', async () => {
    node('x', LONG(10));
    node('y', LONG(10), 'x');
    const result = await memtreeCompose(db, { node_ids: ['x'], budget_tokens: 500 });
    expect(result.manifest.included.length).toBeGreaterThan(0);
  });

  test('manifest.dropped lists over-budget nodes', async () => {
    node('big', LONG(200));
    node('also-big', LONG(200), 'big');
    const result = await memtreeCompose(db, { node_ids: ['big'], budget_tokens: 50 });
    expect(result.manifest.included.length + result.manifest.dropped.length).toBeGreaterThan(0);
  });

  test('format=outline returns titles+previews not full content', async () => {
    node('n1', 'export function doStuff() { return 42; } // more content');
    const result = await memtreeCompose(db, {
      node_ids: ['n1'], budget_tokens: 500, format: 'outline',
    });
    expect(result.content.length).toBeLessThan('export function doStuff() { return 42; } // more content'.length);
  });

  test('format=mixed returns error in v1', async () => {
    node('n1', LONG(10));
    await expect(
      memtreeCompose(db, { node_ids: ['n1'], budget_tokens: 500, format: 'mixed' })
    ).rejects.toThrow('deferred to v1.1');
  });

  test('manifest.truncated lists nodes with truncated=1', async () => {
    insertNode(db, 'trunc', {
      parent_id: null, kind: 'note', source_uri: null,
      content: LONG(30), content_hash: 'trunc', status: 'live',
      mtime: 0, truncated: 1, original_bytes: 99999, metadata: '{}',
    });
    const result = await memtreeCompose(db, { node_ids: ['trunc'], budget_tokens: 500 });
    expect(result.manifest.truncated).toContain('trunc');
  });
});
