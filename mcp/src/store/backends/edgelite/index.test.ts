import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, existsSync } from 'fs';
import path from 'path';
import { createEdgeliteBackend } from './index.js';
import type { StoreBackend } from '../../interface.js';

const TEST_DB = '/tmp/ctx-tree-edgelite-test';
const SCHEMA_PATH = path.join(import.meta.dir, '../../../../dbschema/schema.esdl');

let store: StoreBackend;

beforeEach(async () => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB, { recursive: true });
  store = await createEdgeliteBackend(TEST_DB, SCHEMA_PATH);
});
afterEach(async () => {
  await store.close();
  if (existsSync(TEST_DB)) rmSync(TEST_DB, { recursive: true });
});

describe('EdgeLite backend setup', () => {
  test('createEdgeliteBackend resolves to a StoreBackend', () => {
    expect(typeof store.insertNode).toBe('function');
    expect(typeof store.getNode).toBe('function');
    expect(typeof store.close).toBe('function');
  });
});

describe('insertNode + getNode', () => {
  test('round-trip', async () => {
    await store.insertNode('01eltest01', {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'edgelite test', content_hash: 'abc', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
    });
    const node = await store.getNode('01eltest01');
    expect(node).not.toBeNull();
    expect(node!.content).toBe('edgelite test');
  });
});

describe('updateNodeStatus', () => {
  test('status change persists', async () => {
    await store.insertNode('01elstatus', {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'x', content_hash: 'y', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
    });
    await store.updateNodeStatus('01elstatus', 'stale');
    const node = await store.getNode('01elstatus');
    expect(node!.status).toBe('stale');
  });
});

describe('insertEdge + getEdgesFrom', () => {
  test('round-trip', async () => {
    await store.insertNode('01el-src', {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'src', content_hash: 's', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
    });
    await store.insertNode('01el-dst', {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'dst', content_hash: 'd', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
    });
    await store.insertEdge({ src_id: '01el-src', dst_id: '01el-dst', kind: 'references' });
    const edges = await store.getEdgesFrom('01el-src');
    expect(edges.length).toBe(1);
    expect(edges[0].kind).toBe('references');
  });
});

describe('searchSemantic', () => {
  test('returns empty array when no vectors stored', async () => {
    await store.insertNode('el-sem-0', {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'no vec', content_hash: 'sv0', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
    });
    const results = await store.searchSemantic([1, 0, 0], 'test-model');
    expect(results).toEqual([]);
  });

  test('returns nodes ordered by cosine similarity', async () => {
    await store.insertNode('el-sem-1', {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'first', content_hash: 'sv1', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
    });
    await store.insertNode('el-sem-2', {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'second', content_hash: 'sv2', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
    });

    // el-sem-1: [1,0,0] — perfect match; el-sem-2: [0,1,0] — orthogonal
    await store.batchUpsertNodeVec([
      { id: 'el-sem-1', embedding: Buffer.from(new Float32Array([1, 0, 0]).buffer), model: 'test-model', dim: 3, embeddedAt: Date.now() },
      { id: 'el-sem-2', embedding: Buffer.from(new Float32Array([0, 1, 0]).buffer), model: 'test-model', dim: 3, embeddedAt: Date.now() },
    ]);

    const results = await store.searchSemantic([1, 0, 0], 'test-model', {}, 10);
    expect(results.length).toBe(2);
    expect(results[0].id).toBe('el-sem-1');
  });
});

describe('getNodesByIds', () => {
  test('returns live nodes for matching ids', async () => {
    await store.insertNode('el-gni-1', {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'hello', content_hash: 'h1', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
    });
    const nodes = await store.getNodesByIds(['el-gni-1', 'nonexistent']);
    expect(nodes.length).toBe(1);
    expect(nodes[0].id).toBe('el-gni-1');
  });
  test('returns empty array for empty input', async () => {
    const nodes = await store.getNodesByIds([]);
    expect(nodes).toEqual([]);
  });
});

describe('getRecentNodes', () => {
  test('returns nodes ordered by created_at desc', async () => {
    await store.insertNode('el-rn-1', {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'first', content_hash: 'r1', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
    });
    await store.insertNode('el-rn-2', {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'second', content_hash: 'r2', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
    });
    const nodes = await store.getRecentNodes(undefined, 10);
    expect(nodes.length).toBeGreaterThanOrEqual(2);
    expect(nodes[0].created_at).toBeGreaterThanOrEqual(nodes[1].created_at);
  });
});

describe('getPathToRoot', () => {
  test('returns path from node to root', async () => {
    await store.insertNode('el-root', {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'root', content_hash: 'p0', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
    });
    await store.insertNode('el-child', {
      parent_id: 'el-root', kind: 'note', source_uri: null,
      content: 'child', content_hash: 'p1', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
    });
    const path = await store.getPathToRoot('el-child');
    expect(path.length).toBe(2);
    expect(path[0].id).toBe('el-child');
    expect(path[1].id).toBe('el-root');
  });
});

describe('markNodeStatusPruned', () => {
  test('sets status to pruned', async () => {
    await store.insertNode('el-prune', {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'data', content_hash: 'pr1', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
    });
    await store.markNodeStatusPruned('el-prune', Date.now());
    const node = await store.getNode('el-prune');
    expect(node!.status).toBe('pruned');
  });
});

describe('getNodesNeedingSummarization', () => {
  test('returns nodes with long content and no summary', async () => {
    const longContent = 'x'.repeat(300);
    await store.insertNode('el-sum-1', {
      parent_id: null, kind: 'note', source_uri: null,
      content: longContent, content_hash: 'sm1', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
    });
    const nodes = await store.getNodesNeedingSummarization(100, 10);
    expect(nodes.some(n => n.id === 'el-sum-1')).toBe(true);
  });
});

describe('vector/embedding', () => {
  test('getPendingEmbeddingNodes returns live nodes without vectors', async () => {
    await store.insertNode('el-penv-1', {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'needs embedding', content_hash: 'pe1', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
    });
    const pending = await store.getPendingEmbeddingNodes(10);
    expect(pending.some(n => n.id === 'el-penv-1')).toBe(true);
  });

  test('batchUpsertNodeVec stores embedding and removes from pending', async () => {
    await store.insertNode('el-buv-1', {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'has embedding', content_hash: 'bv1', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
    });
    await store.batchUpsertNodeVec([
      { id: 'el-buv-1', embedding: Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer), model: 'test-model', dim: 3, embeddedAt: Date.now() },
    ]);
    const pending = await store.getPendingEmbeddingNodes(10);
    expect(pending.some(n => n.id === 'el-buv-1')).toBe(false);
  });

  test('getStoredEmbeddingModels returns stored model names', async () => {
    await store.insertNode('el-gsem-1', {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'model test', content_hash: 'gs1', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
    });
    await store.batchUpsertNodeVec([
      { id: 'el-gsem-1', embedding: Buffer.from(new Float32Array([0.5, 0.5, 0]).buffer), model: 'test-model', dim: 3, embeddedAt: Date.now() },
    ]);
    const models = await store.getStoredEmbeddingModels();
    expect(models).toContain('test-model');
  });

  test('getDedupeCandidatePairs returns empty array', async () => {
    expect(await store.getDedupeCandidatePairs()).toEqual([]);
  });
});
