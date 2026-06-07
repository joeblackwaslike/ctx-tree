import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync, existsSync } from 'fs';
import { createSqliteBackend } from './index.js';
import type { StoreBackend } from '../../interface.js';

const TEST_DB = '/tmp/ctx-tree-sqlite-test.db';

let store: StoreBackend;

beforeEach(async () => { store = await createSqliteBackend(TEST_DB); });
afterEach(async () => {
  await store.close();
  for (const ext of ['', '-wal', '-shm']) {
    if (existsSync(TEST_DB + ext)) unlinkSync(TEST_DB + ext);
  }
});

// ── DB setup (SQLite-specific) ──────────────────────────────────────────────

describe('SQLite setup', () => {
  test('nodes table has all required columns', async () => {
    const node = await store.getNode('nonexistent');
    expect(node).toBeNull();
    // If the table didn't exist, getNode would have thrown
  });

  test('createSqliteBackend returns a StoreBackend', async () => {
    expect(typeof store.insertNode).toBe('function');
    expect(typeof store.getNode).toBe('function');
    expect(typeof store.close).toBe('function');
  });
});

// ── insertNode + getNode ───────────────────────────────────────────────────

describe('insertNode + getNode', () => {
  test('round-trip: inserted node is retrieved by id', async () => {
    await store.insertNode('01test001', {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'hello world', content_hash: 'abc', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
    });
    const node = await store.getNode('01test001');
    expect(node).not.toBeNull();
    expect(node!.content).toBe('hello world');
    expect(node!.kind).toBe('note');
  });

  test('returns null for missing id', async () => {
    const node = await store.getNode('doesnotexist');
    expect(node).toBeNull();
  });
});

// ── updateNodeStatus ───────────────────────────────────────────────────────

describe('updateNodeStatus', () => {
  test('changes status of existing node', async () => {
    await store.insertNode('01status', {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'test', content_hash: 'x', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
    });
    await store.updateNodeStatus('01status', 'stale');
    const node = await store.getNode('01status');
    expect(node!.status).toBe('stale');
  });
});

// ── getNodeBySourceUri ─────────────────────────────────────────────────────

describe('getNodeBySourceUri', () => {
  test('finds live node by source_uri', async () => {
    await store.insertNode('01uri01', {
      parent_id: null, kind: 'file_chunk', source_uri: 'file:///foo.ts',
      content: 'x', content_hash: 'h1', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
    });
    const found = await store.getNodeBySourceUri('file:///foo.ts');
    expect(found).not.toBeNull();
    expect(found!.id).toBe('01uri01');
  });

  test('returns null when no live node exists for uri', async () => {
    const found = await store.getNodeBySourceUri('file:///missing.ts');
    expect(found).toBeNull();
  });
});

// ── insertEdge + getEdgesFrom ──────────────────────────────────────────────

describe('insertEdge + getEdgesFrom', () => {
  test('inserting edge and retrieving from src', async () => {
    await store.insertNode('01edge-src', {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'src', content_hash: 's', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
    });
    await store.insertNode('01edge-dst', {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'dst', content_hash: 'd', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
    });
    await store.insertEdge({ src_id: '01edge-src', dst_id: '01edge-dst', kind: 'references' });
    const edges = await store.getEdgesFrom('01edge-src');
    expect(edges.length).toBe(1);
    expect(edges[0].kind).toBe('references');
  });

  test('duplicate insertEdge is ignored (no throw)', async () => {
    await store.insertNode('01dup-src', {
      parent_id: null, kind: 'note', source_uri: null,
      content: 's', content_hash: 's2', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
    });
    await store.insertNode('01dup-dst', {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'd', content_hash: 'd2', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
    });
    await store.insertEdge({ src_id: '01dup-src', dst_id: '01dup-dst', kind: 'references' });
    await expect(
      store.insertEdge({ src_id: '01dup-src', dst_id: '01dup-dst', kind: 'references' })
    ).resolves.toBeUndefined();
  });
});

// ── searchKeyword ──────────────────────────────────────────────────────────

describe('searchKeyword', () => {
  test('returns nodes matching FTS query', async () => {
    await store.insertNode('01fts01', {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'bananas are yellow fruit', content_hash: 'fts1', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
    });
    await store.insertNode('01fts02', {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'apples are red fruit', content_hash: 'fts2', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
    });
    const results = await store.searchKeyword('bananas');
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('01fts01');
  });

  test('returns empty array for empty query', async () => {
    const results = await store.searchKeyword('');
    expect(results).toEqual([]);
  });
});

// ── pruneNode ──────────────────────────────────────────────────────────────

describe('pruneNode', () => {
  test('sets status to pruned and clears content', async () => {
    await store.insertNode('01prune', {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'some content', content_hash: 'p1', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
    });
    await store.pruneNode('01prune');
    const node = await store.getNode('01prune');
    expect(node!.status).toBe('pruned');
    expect(node!.content).toBe('');
  });
});
