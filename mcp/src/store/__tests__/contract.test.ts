import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, unlinkSync, existsSync } from 'fs';
import path from 'path';
import { createSqliteBackend } from '../backends/sqlite/index.js';
import { createEdgeliteBackend } from '../backends/edgelite/index.js';
import type { StoreBackend } from '../interface.js';

const SCHEMA_PATH = path.join(import.meta.dir, '../../../dbschema/schema.esdl');

const fixtures = [
  {
    name: 'sqlite',
    dbPath: '/tmp/mt-contract-sqlite.db',
    create: async () => createSqliteBackend('/tmp/mt-contract-sqlite.db'),
    cleanup: () => {
      for (const ext of ['', '-wal', '-shm']) {
        if (existsSync('/tmp/mt-contract-sqlite.db' + ext))
          unlinkSync('/tmp/mt-contract-sqlite.db' + ext);
      }
    },
  },
  {
    name: 'edgelite',
    dbPath: '/tmp/mt-contract-edgelite',
    create: async () => createEdgeliteBackend('/tmp/mt-contract-edgelite', SCHEMA_PATH),
    cleanup: () => {
      if (existsSync('/tmp/mt-contract-edgelite'))
        rmSync('/tmp/mt-contract-edgelite', { recursive: true });
    },
  },
];

for (const { name, create, cleanup } of fixtures) {
  describe(`StoreBackend contract [${name}]`, () => {
    let store: StoreBackend;

    beforeEach(async () => {
      cleanup();
      store = await create();
    });
    afterEach(async () => {
      await store.close();
      cleanup();
    });

    test('insertNode + getNode round-trip', async () => {
      await store.insertNode('ct-001', {
        parent_id: null, kind: 'note', source_uri: null,
        content: 'contract test', content_hash: 'ct1', status: 'live',
        mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
      });
      const node = await store.getNode('ct-001');
      expect(node).not.toBeNull();
      expect(node!.content).toBe('contract test');
      expect(node!.status).toBe('live');
    });

    test('getNode returns null for missing id', async () => {
      expect(await store.getNode('missing')).toBeNull();
    });

    test('updateNodeStatus persists', async () => {
      await store.insertNode('ct-002', {
        parent_id: null, kind: 'note', source_uri: null,
        content: 'x', content_hash: 'c2', status: 'live',
        mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
      });
      await store.updateNodeStatus('ct-002', 'stale');
      const n = await store.getNode('ct-002');
      expect(n!.status).toBe('stale');
    });

    test('getNodeBySourceUri finds live node', async () => {
      await store.insertNode('ct-003', {
        parent_id: null, kind: 'file_chunk', source_uri: 'file:///contract.ts',
        content: 'c', content_hash: 'c3', status: 'live',
        mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
      });
      const found = await store.getNodeBySourceUri('file:///contract.ts');
      expect(found!.id).toBe('ct-003');
    });

    test('pruneNode clears content + sets status', async () => {
      await store.insertNode('ct-004', {
        parent_id: null, kind: 'note', source_uri: null,
        content: 'tbd', content_hash: 'c4', status: 'live',
        mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
      });
      await store.pruneNode('ct-004');
      const n = await store.getNode('ct-004');
      expect(n!.status).toBe('pruned');
      expect(n!.content).toBe('');
    });

    test('insertEdge + getEdgesFrom', async () => {
      await store.insertNode('ct-src', {
        parent_id: null, kind: 'note', source_uri: null,
        content: 's', content_hash: 'cs', status: 'live',
        mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
      });
      await store.insertNode('ct-dst', {
        parent_id: null, kind: 'note', source_uri: null,
        content: 'd', content_hash: 'cd', status: 'live',
        mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
      });
      await store.insertEdge({ src_id: 'ct-src', dst_id: 'ct-dst', kind: 'references' });
      const edges = await store.getEdgesFrom('ct-src');
      expect(edges.length).toBe(1);
      expect(edges[0].kind).toBe('references');
    });

    test('searchSemantic throws NotImplemented on edgelite', async () => {
      if (name !== 'edgelite') return;
      await expect(store.searchSemantic([1, 2, 3], 'model')).rejects.toThrow('NotImplemented');
    });
  });
}
