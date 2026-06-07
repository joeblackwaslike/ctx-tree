import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync, existsSync } from 'fs';
import { openDb, closeDb } from '../store/db';
import { insertNode } from '../store/nodes';
import { searchSemantic, searchHybrid } from './search';
import { wrapDatabase } from '../store/backends/sqlite/index.js';
import type { Database } from 'bun:sqlite';
import type { StoreBackend } from '../store/index.js';
import type { EmbeddingProvider, CtxTreeConfig, Filters } from '../store/types';

const TEST_DB = '/tmp/ctx-tree-search-semantic-test.db';
let db: Database;
let store: StoreBackend;

const config: CtxTreeConfig = {
  embeddingModel: 'test-model',
  summarizerModel: 'test-model',
  retention: { staleHours: 24, supersededDays: 7 },
  walkers: {
    embeddingIdleMs: 1000,
    embeddingBatchSize: 8,
    summarizerSubtreeThreshold: 5,
    dedupeIntervalMs: 5000,
    stalenessIntervalMs: 5000,
    prunerIntervalMs: 5000,
  },
  capture: { maxBytes: 65536, filterMinSize: 16 },
};

function makeProvider(embeddings: Record<string, number[]>): EmbeddingProvider {
  return {
    model: 'test-model',
    dim: 3,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(t => embeddings[t] ?? [0, 0, 0]);
    },
  };
}

function node(id: string, content: string) {
  insertNode(db, id, {
    parent_id: null,
    kind: 'note',
    source_uri: null,
    content,
    content_hash: id,
    status: 'live',
    mtime: 0,
    truncated: 0,
    original_bytes: content.length,
    metadata: '{}',
  });
}

function insertEmbedding(id: string, vec: number[], model = 'test-model') {
  const buf = new Float32Array(vec);
  db.run(
    `INSERT INTO nodes_vec (id, embedding, embedding_model, embedding_dim, embedded_at)
     VALUES (?, ?, ?, ?, ?)`,
    id,
    new Uint8Array(buf.buffer),
    model,
    vec.length,
    Date.now(),
  );
}

beforeEach(() => {
  db = openDb(TEST_DB);
  store = wrapDatabase(db);
});

afterEach(() => {
  closeDb(db);
  for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm'])
    if (existsSync(f)) unlinkSync(f);
});

describe('searchSemantic', () => {
  test('throws when provider is null', async () => {
    await expect(
      searchSemantic(store, config, null, 'query', 10)
    ).rejects.toThrow('semantic search requires an embedding provider');
  });

  test('returns empty results when nodes_vec is empty', async () => {
    node('n1', 'some content here');
    const provider = makeProvider({ query: [1, 0, 0] });
    const result = await searchSemantic(store, config, provider, 'query', 10);
    expect(result.nodes).toHaveLength(0);
  });

  test('returns results sorted by cosine similarity descending', async () => {
    node('n1', 'content one');
    node('n2', 'content two');
    node('n3', 'content three');

    // n1 is very similar to query [1,0,0]: same direction
    insertEmbedding('n1', [1, 0, 0]);
    // n2 is somewhat similar: [0.8, 0.6, 0]
    insertEmbedding('n2', [0.8, 0.6, 0]);
    // n3 is orthogonal: [0, 1, 0]
    insertEmbedding('n3', [0, 1, 0]);

    const provider = makeProvider({ query: [1, 0, 0] });
    const result = await searchSemantic(store, config, provider, 'query', 3);

    expect(result.nodes.length).toBeGreaterThan(0);
    // n1 should come first (highest similarity to [1,0,0])
    expect(result.nodes[0].id).toBe('n1');
    // n3 ([0,1,0] vs [1,0,0] = dot=0) should come last
    expect(result.nodes[result.nodes.length - 1].id).toBe('n3');
  });

  test('respects limit', async () => {
    for (let i = 1; i <= 5; i++) {
      node(`n${i}`, `content ${i}`);
      insertEmbedding(`n${i}`, [i * 0.1, 0, 0]);
    }
    const provider = makeProvider({ query: [1, 0, 0] });
    const result = await searchSemantic(store, config, provider, 'query', 2);
    expect(result.nodes).toHaveLength(2);
  });

  test('only returns live nodes (filter default)', async () => {
    node('live1', 'live content here');
    node('stale1', 'stale content here');
    insertEmbedding('live1', [1, 0, 0]);
    insertEmbedding('stale1', [1, 0, 0]);
    db.run(`UPDATE nodes SET status = 'stale' WHERE id = 'stale1'`);

    const provider = makeProvider({ query: [1, 0, 0] });
    const result = await searchSemantic(store, config, provider, 'query', 10);
    const ids = result.nodes.map(n => n.id);
    expect(ids).toContain('live1');
    expect(ids).not.toContain('stale1');
  });

  test('throws on embedding model mismatch', async () => {
    node('n1', 'some content');
    insertEmbedding('n1', [1, 0, 0], 'different-model');

    const provider = makeProvider({ query: [1, 0, 0] });
    await expect(
      searchSemantic(store, config, provider, 'query', 10)
    ).rejects.toThrow('embedding model mismatch: re-embed required before semantic search');
  });
});

describe('searchHybrid', () => {
  test('throws when provider is null', async () => {
    await expect(
      searchHybrid(store, config, null, 'query', 10)
    ).rejects.toThrow('hybrid search requires an embedding provider');
  });

  test('throws on embedding model mismatch', async () => {
    node('n1', 'some content here');
    insertEmbedding('n1', [1, 0, 0], 'wrong-model');

    const provider = makeProvider({ query: [1, 0, 0] });
    await expect(
      searchHybrid(store, config, provider, 'query', 10)
    ).rejects.toThrow('embedding model mismatch: re-embed required before semantic search');
  });

  test('combines keyword and semantic results via RRF', async () => {
    // n1: keyword match, low semantic similarity
    node('n1', 'fox jumps over the dog keyword match');
    insertEmbedding('n1', [0, 0, 1]);

    // n2: no keyword match, high semantic similarity
    node('n2', 'completely different words here now');
    insertEmbedding('n2', [1, 0, 0]);

    // n3: both keyword and semantic match (should score highest)
    node('n3', 'fox jumps keyword and semantic match here');
    insertEmbedding('n3', [0.99, 0.1, 0]);

    const provider = makeProvider({ 'fox jumps': [1, 0, 0] });
    const result = await searchHybrid(store, config, provider, 'fox jumps', 5);

    expect(result.nodes.length).toBeGreaterThan(0);
    // All nodes should appear (merged from both lists)
    const ids = result.nodes.map(n => n.id);
    // n3 appears in both keyword and semantic lists, so it should be present
    expect(ids).toContain('n3');
    // n2 has no keyword match but a semantic match — should still appear via fusion
    expect(ids).toContain('n2');
    // n3 should rank above n2 (n3 has both keyword + semantic, n2 has only semantic)
    expect(ids.indexOf('n3')).toBeLessThan(ids.indexOf('n2'));
  });

  test('deduplicates nodes that appear in both result lists', async () => {
    node('n1', 'unique overlap content here fox');
    insertEmbedding('n1', [1, 0, 0]);

    const provider = makeProvider({ fox: [1, 0, 0] });
    const result = await searchHybrid(store, config, provider, 'fox', 20);

    // n1 may appear in both keyword and semantic — ensure it only appears once
    const ids = result.nodes.map(n => n.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  test('respects limit on merged results', async () => {
    for (let i = 1; i <= 10; i++) {
      node(`n${i}`, `keyword match fox content ${i}`);
      insertEmbedding(`n${i}`, [i * 0.1, 0, 0]);
    }
    const provider = makeProvider({ fox: [1, 0, 0] });
    const result = await searchHybrid(store, config, provider, 'fox', 3);
    expect(result.nodes).toHaveLength(3);
  });
});
