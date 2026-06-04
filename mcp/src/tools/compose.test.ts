import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync, existsSync } from 'fs';
import { openDb, closeDb } from '../store/db';
import { insertNode } from '../store/nodes';
import { insertEdge } from '../store/edges';
import { ctxTreeCompose } from './compose';
import { wrapDatabase } from '../store/backends/sqlite/index.js';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { StoreBackend } from '../store/index.js';

const TEST_DB = '/tmp/ctx-tree-compose-test.db';
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

const LONG = (n: number) => Array(n).fill('word').join(' ');

describe('ctxTreeCompose', () => {
  test('returns content within budget_tokens', async () => {
    node('a', LONG(50));
    node('b', LONG(50), 'a');
    node('c', LONG(50), 'a');
    const result = await ctxTreeCompose(store, { node_ids: ['a'], budget_tokens: 100 });
    const approxTokens = Math.ceil(result.content.length / 4);
    expect(approxTokens).toBeLessThanOrEqual(110);
  });

  test('manifest.included lists packed node IDs', async () => {
    node('x', LONG(10));
    node('y', LONG(10), 'x');
    const result = await ctxTreeCompose(store, { node_ids: ['x'], budget_tokens: 500 });
    expect(result.manifest.included.length).toBeGreaterThan(0);
  });

  test('manifest.dropped lists over-budget nodes with reason', async () => {
    node('big', LONG(200));
    node('also-big', LONG(200), 'big');
    const result = await ctxTreeCompose(store, { node_ids: ['big'], budget_tokens: 50 });
    expect(result.manifest.dropped.length).toBeGreaterThan(0);
    expect(result.manifest.dropped[0].reason).toBe('over_budget');
  });

  test('format=outline returns titles+previews not full content', async () => {
    const fullContent = 'export function doStuff() { return 42; } // more content here padding';
    node('n1', fullContent);
    const result = await ctxTreeCompose(store, {
      node_ids: ['n1'], budget_tokens: 500, format: 'outline',
    });
    // Outline must be shorter than the full body
    expect(result.content.length).toBeLessThan(fullContent.length);
    // Outline must not include the full function body verbatim
    expect(result.content).not.toContain(fullContent);
    // Outline must include the node ID prefix
    expect(result.content).toContain('n1');
  });

  test('format=mixed substitutes summary for over-budget nodes', async () => {
    // Small node fits in budget, large node uses its summary
    insertNode(db, 'small', {
      parent_id: null, kind: 'note', source_uri: null,
      content: LONG(10), content_hash: 'small', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 40, metadata: '{}',
    });
    insertNode(db, 'large', {
      parent_id: null, kind: 'note', source_uri: null,
      content: LONG(200), content_hash: 'large', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 800, metadata: '{}',
    });
    // Give 'large' a summary by updating directly
    db.run("UPDATE nodes SET summary = 'This is the summary of large.' WHERE id = 'large'");

    // Budget: enough for 'small' raw + 'large' summary, but not 'large' raw
    const result = await ctxTreeCompose(store, {
      node_ids: ['small', 'large'], budget_tokens: 60, format: 'mixed',
    });

    expect(result.manifest.included).toContain('large');
    expect(result.manifest.summary_substituted).toContain('large');
    expect(result.content).toContain('This is the summary of large.');
  });

  test('format=mixed drops over-budget nodes with no summary', async () => {
    insertNode(db, 'big-nosummary', {
      parent_id: null, kind: 'note', source_uri: null,
      content: LONG(200), content_hash: 'big-nosummary', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 800, metadata: '{}',
    });
    // No summary set — summary column is NULL

    const result = await ctxTreeCompose(store, {
      node_ids: ['big-nosummary'], budget_tokens: 10, format: 'mixed',
    });

    expect(result.manifest.included).not.toContain('big-nosummary');
    const drop = result.manifest.dropped.find(d => d.id === 'big-nosummary');
    expect(drop?.reason).toBe('over_budget_no_summary');
    expect(result.manifest.summary_substituted).toBeUndefined();
  });

  test('format=mixed with all nodes fitting budget uses raw content', async () => {
    node('fits1', LONG(10));
    node('fits2', LONG(10));

    const result = await ctxTreeCompose(store, {
      node_ids: ['fits1', 'fits2'], budget_tokens: 500, format: 'mixed',
    });

    expect(result.manifest.included).toContain('fits1');
    expect(result.manifest.included).toContain('fits2');
    expect(result.manifest.dropped).toHaveLength(0);
    // No summary substitution needed
    expect(result.manifest.summary_substituted).toBeUndefined();
  });

  test('format=raw drops over-budget nodes with reason over_budget', async () => {
    node('big', LONG(200));
    const result = await ctxTreeCompose(store, {
      node_ids: ['big'], budget_tokens: 10, format: 'raw',
    });
    const drop = result.manifest.dropped.find(d => d.id === 'big');
    expect(drop?.reason).toBe('over_budget');
  });

  test('format=outline drops over-budget outlines with reason over_budget', async () => {
    // Insert many nodes so budget overflows even for outlines
    for (let i = 0; i < 20; i++) {
      node(`ol${i}`, LONG(30));
    }
    const result = await ctxTreeCompose(store, {
      node_ids: Array.from({ length: 20 }, (_, i) => `ol${i}`), budget_tokens: 5, format: 'outline',
    });
    expect(result.manifest.dropped.length).toBeGreaterThan(0);
    expect(result.manifest.dropped[0].reason).toBe('over_budget');
  });

  test('manifest.truncated lists nodes with truncated=1', async () => {
    insertNode(db, 'trunc', {
      parent_id: null, kind: 'note', source_uri: null,
      content: LONG(30), content_hash: 'trunc', status: 'live',
      mtime: 0, truncated: 1, original_bytes: 99999, metadata: '{}',
    });
    const result = await ctxTreeCompose(store, { node_ids: ['trunc'], budget_tokens: 500 });
    expect(result.manifest.truncated).toContain('trunc');
  });
});
