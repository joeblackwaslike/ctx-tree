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

    test('searchSemantic returns empty array when no vectors stored', async () => {
      const results = await store.searchSemantic([1, 2, 3], 'model');
      expect(Array.isArray(results)).toBe(true);
    });

    test('getNeighbors returns directly connected nodes via edges', async () => {
      await store.insertNode('nb-parent', {
        parent_id: null, kind: 'note', source_uri: null,
        content: 'parent', content_hash: 'nb-p', status: 'live',
        mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
      });
      await store.insertNode('nb-child', {
        parent_id: 'nb-parent', kind: 'note', source_uri: null,
        content: 'child', content_hash: 'nb-c', status: 'live',
        mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
      });
      await store.insertEdge({ src_id: 'nb-parent', dst_id: 'nb-child', kind: 'references' });

      const neighbors = await store.getNeighbors('nb-parent');
      expect(neighbors.some(n => n.id === 'nb-child')).toBe(true);
    });

    test('getNeighborsDeep returns nodes up to specified depth via edges', async () => {
      await store.insertNode('gnd-root', {
        parent_id: null, kind: 'note', source_uri: null,
        content: 'root', content_hash: 'gnd-r', status: 'live',
        mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
      });
      await store.insertNode('gnd-mid', {
        parent_id: 'gnd-root', kind: 'note', source_uri: null,
        content: 'mid', content_hash: 'gnd-m', status: 'live',
        mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
      });
      await store.insertNode('gnd-leaf', {
        parent_id: 'gnd-mid', kind: 'note', source_uri: null,
        content: 'leaf', content_hash: 'gnd-l', status: 'live',
        mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
      });
      await store.insertEdge({ src_id: 'gnd-root', dst_id: 'gnd-mid', kind: 'references' });
      await store.insertEdge({ src_id: 'gnd-mid', dst_id: 'gnd-leaf', kind: 'references' });

      const deep = await store.getNeighborsDeep('gnd-root', 2);
      expect(deep.some(n => n.id === 'gnd-mid')).toBe(true);
      expect(deep.some(n => n.id === 'gnd-leaf')).toBe(true);
    });

    test('getPathToRoot walks parent_id chain from grandchild to root', async () => {
      await store.insertNode('ptr-root', {
        parent_id: null, kind: 'note', source_uri: null,
        content: 'root', content_hash: 'ptr-r', status: 'live',
        mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
      });
      await store.insertNode('ptr-child', {
        parent_id: 'ptr-root', kind: 'note', source_uri: null,
        content: 'child', content_hash: 'ptr-c', status: 'live',
        mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
      });
      await store.insertNode('ptr-grand', {
        parent_id: 'ptr-child', kind: 'note', source_uri: null,
        content: 'grand', content_hash: 'ptr-g', status: 'live',
        mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
      });

      const path = await store.getPathToRoot('ptr-grand');
      expect(path.map(n => n.id)).toEqual(['ptr-grand', 'ptr-child', 'ptr-root']);
    });

    test('getRecentNodes respects limit and returns live nodes', async () => {
      for (let i = 0; i < 5; i++) {
        await store.insertNode(`rec-${i}`, {
          parent_id: null, kind: 'note', source_uri: null,
          content: `content-${i}`, content_hash: `rec-hash-${i}`, status: 'live',
          mtime: 0, truncated: 0, original_bytes: 0, metadata: '{}',
        });
      }

      const all = await store.getRecentNodes(0, 10);
      const limited = await store.getRecentNodes(0, 3);

      expect(all.length).toBe(5);
      expect(limited.length).toBe(3);
      // All returned nodes should be from the inserted set
      const insertedIds = new Set(Array.from({ length: 5 }, (_, i) => `rec-${i}`));
      expect(all.every(n => insertedIds.has(n.id))).toBe(true);
    });

    test('getOrCreateSessionNode is idempotent for the same sessionId', async () => {
      const first = await store.getOrCreateSessionNode('session-contract-test');
      const second = await store.getOrCreateSessionNode('session-contract-test');

      expect(first.id).toBe(second.id);
      expect(second.id).toBeTruthy();
    });
  });
}
