import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync, existsSync } from 'fs';
import { openDb, closeDb } from '../store/db.js';
import { insertNode } from '../store/nodes.js';
import { runEmbeddingWalker } from './embedding.js';
import { ulid } from 'ulid';
import { DEFAULT_CONFIG } from '../config.js';
import type { Database } from 'bun:sqlite';
import type { EmbeddingProvider } from '../store/types.js';

const TEST_DB = '/tmp/memtree-embedding-test.db';
let db: Database;
const cfg = DEFAULT_CONFIG;

const mockProvider: EmbeddingProvider = {
  model: 'mock-model',
  dim: 4,
  embed: async (texts: string[]) => texts.map(() => [1, 2, 3, 4]),
};

function insertLiveNode(id: string, content = 'content long enough to be live here') {
  insertNode(db, id, {
    parent_id: null, kind: 'note', source_uri: null,
    content, content_hash: id,
    status: 'live', mtime: 0, truncated: 0, original_bytes: content.length, metadata: '{}',
  });
}

beforeEach(() => { db = openDb(TEST_DB); });
afterEach(() => {
  closeDb(db);
  for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm'])
    if (existsSync(f)) unlinkSync(f);
});

describe('embedding walker', () => {
  test('no-ops when provider is null', () => {
    const id = ulid();
    insertLiveNode(id);
    runEmbeddingWalker(db, cfg, null);
    // give any async a tick to settle — but since provider is null, nothing should happen
    const row = db.query('SELECT id FROM nodes_vec WHERE id = ?').get(id);
    expect(row).toBeNull();
  });

  test('fetches unembedded live nodes and writes to nodes_vec', async () => {
    const id = ulid();
    insertLiveNode(id);
    runEmbeddingWalker(db, cfg, mockProvider);
    // wait for the async embed+insert to complete
    await new Promise(r => setTimeout(r, 50));
    const row = db.query<{ id: string; embedding: Uint8Array; embedding_model: string; embedding_dim: number; embedded_at: number }, [string]>(
      'SELECT id, embedding, embedding_model, embedding_dim, embedded_at FROM nodes_vec WHERE id = ?'
    ).get(id);
    expect(row).not.toBeNull();
    expect(row!.id).toBe(id);
    expect(row!.embedding_model).toBe('mock-model');
    expect(row!.embedding_dim).toBe(4);
    expect(row!.embedding).toBeInstanceOf(Uint8Array);
    expect(row!.embedding.byteLength).toBe(4 * 4); // 4 floats * 4 bytes each
    expect(row!.embedded_at).toBeGreaterThan(0);
  });

  test('skips nodes already in nodes_vec', async () => {
    const id = ulid();
    insertLiveNode(id);
    // Pre-insert into nodes_vec
    const fakeBlob = Buffer.from(new Float32Array([1, 2, 3, 4]).buffer);
    db.run(
      'INSERT INTO nodes_vec (id, embedding, embedding_model, embedding_dim, embedded_at) VALUES (?, ?, ?, ?, ?)',
      id, fakeBlob, 'mock-model', 4, Date.now()
    );

    let embedCallCount = 0;
    const countingProvider: EmbeddingProvider = {
      model: 'mock-model',
      dim: 4,
      embed: async (texts: string[]) => {
        embedCallCount += texts.length;
        return texts.map(() => [1, 2, 3, 4]);
      },
    };

    runEmbeddingWalker(db, cfg, countingProvider);
    await new Promise(r => setTimeout(r, 50));
    expect(embedCallCount).toBe(0);
  });

  test('handles provider error gracefully (logs to stderr, does not throw)', async () => {
    const id = ulid();
    insertLiveNode(id);

    const errorProvider: EmbeddingProvider = {
      model: 'error-model',
      dim: 4,
      embed: async () => { throw new Error('embedding service unavailable'); },
    };

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: string) => { stderrChunks.push(chunk); return true; };

    try {
      // Should not throw
      expect(() => runEmbeddingWalker(db, cfg, errorProvider)).not.toThrow();
      await new Promise(r => setTimeout(r, 50));
      const logged = stderrChunks.join('');
      expect(logged).toMatch(/memtree embedding error/);
    } finally {
      (process.stderr as any).write = originalWrite;
    }

    // Node should NOT be in nodes_vec since embed failed
    const row = db.query('SELECT id FROM nodes_vec WHERE id = ?').get(id);
    expect(row).toBeNull();
  });

  test('nodes_vec row has correct embedding_model, embedding_dim, and non-null BLOB embedding', async () => {
    const id = ulid();
    insertLiveNode(id, 'some content that is definitely long enough for the test');
    runEmbeddingWalker(db, cfg, mockProvider);
    await new Promise(r => setTimeout(r, 50));

    const row = db.query<{ embedding: Uint8Array; embedding_model: string; embedding_dim: number }, [string]>(
      'SELECT embedding, embedding_model, embedding_dim FROM nodes_vec WHERE id = ?'
    ).get(id);

    expect(row).not.toBeNull();
    expect(row!.embedding_model).toBe('mock-model');
    expect(row!.embedding_dim).toBe(4);
    // Verify BLOB is a Float32Array encoding of [1, 2, 3, 4]
    const floats = new Float32Array(row!.embedding.buffer, row!.embedding.byteOffset, row!.embedding.byteLength / 4);
    expect(Array.from(floats)).toEqual([1, 2, 3, 4]);
  });
});
