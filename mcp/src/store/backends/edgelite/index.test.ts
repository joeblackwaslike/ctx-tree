import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, existsSync } from 'fs';
import path from 'path';
import { createEdgeliteBackend } from './index.js';
import type { StoreBackend } from '../../interface.js';

const TEST_DB = '/tmp/memtree-edgelite-test';
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

describe('NotImplemented methods', () => {
  test('searchSemantic throws NotImplemented', async () => {
    await expect(store.searchSemantic([1, 2, 3], 'test-model')).rejects.toThrow('NotImplemented');
  });
  test('getNodesByIds throws NotImplemented', async () => {
    await expect(store.getNodesByIds(['x'])).rejects.toThrow('NotImplemented');
  });
});
