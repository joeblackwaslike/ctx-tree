import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync, existsSync } from 'fs';
import { openDb, closeDb } from '../store/db.js';
import { insertNode } from '../store/nodes.js';
import { getEdgesFrom } from '../store/edges.js';
import { runDedupeWalker } from './dedupe.js';
import { ulid } from 'ulid';
import { DEFAULT_CONFIG } from '../config.js';
import type { Database } from 'bun:sqlite';

const TEST_DB = '/tmp/memtree-dedupe-test.db';
const cfg = DEFAULT_CONFIG;
let db: Database;

function insertFileChunk(id: string, sourceUri: string, createdAtOffset = 0): void {
  insertNode(db, id, {
    parent_id: null,
    kind: 'file_chunk',
    source_uri: sourceUri,
    content: `chunk content for ${id}`,
    content_hash: id,
    status: 'live',
    mtime: 0,
    truncated: 0,
    original_bytes: 20,
    metadata: '{}',
  });
  if (createdAtOffset !== 0) {
    db.run(`UPDATE nodes SET created_at = created_at + ? WHERE id = ?`, createdAtOffset, id);
  }
}

function insertEmbedding(id: string, vector: number[]): void {
  const blob = Buffer.from(new Float32Array(vector).buffer);
  db.run(
    `INSERT INTO nodes_vec (id, embedding, embedding_model, embedding_dim, embedded_at)
     VALUES (?, ?, ?, ?, ?)`,
    id, blob, 'test-model', vector.length, Date.now()
  );
}

beforeEach(() => { db = openDb(TEST_DB); });
afterEach(() => {
  closeDb(db);
  for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm'])
    if (existsSync(f)) unlinkSync(f);
});

describe('dedupe walker', () => {
  test('no-ops when no nodes have embeddings', () => {
    const id = ulid();
    insertFileChunk(id, 'file:///test.ts');
    // No nodes_vec row — should be a no-op
    runDedupeWalker(db, cfg);
    const row = db.query(`SELECT status FROM nodes WHERE id = ?`).get(id) as { status: string } | null;
    expect(row?.status).toBe('live');
  });

  test('prunes older of two near-duplicate nodes (cosine > 0.95)', () => {
    const id1 = ulid();
    const id2 = ulid();
    insertFileChunk(id1, 'file:///dup.ts', 0);
    insertFileChunk(id2, 'file:///dup.ts', 1000); // id2 is newer

    // Identical embeddings → cosine = 1.0
    insertEmbedding(id1, [1, 0, 0, 0]);
    insertEmbedding(id2, [1, 0, 0, 0]);

    runDedupeWalker(db, cfg);

    const r1 = db.query(`SELECT status FROM nodes WHERE id = ?`).get(id1) as { status: string };
    const r2 = db.query(`SELECT status FROM nodes WHERE id = ?`).get(id2) as { status: string };

    // id2 is newer (created_at higher), so id1 should be pruned
    expect(r1.status).toBe('pruned');
    expect(r2.status).toBe('live');
  });

  test('keeps both nodes when similarity is below threshold (< 0.95)', () => {
    const id1 = ulid();
    const id2 = ulid();
    insertFileChunk(id1, 'file:///diff.ts');
    insertFileChunk(id2, 'file:///diff.ts');

    // Orthogonal embeddings → cosine = 0.0
    insertEmbedding(id1, [1, 0, 0, 0]);
    insertEmbedding(id2, [0, 1, 0, 0]);

    runDedupeWalker(db, cfg);

    const r1 = db.query(`SELECT status FROM nodes WHERE id = ?`).get(id1) as { status: string };
    const r2 = db.query(`SELECT status FROM nodes WHERE id = ?`).get(id2) as { status: string };
    expect(r1.status).toBe('live');
    expect(r2.status).toBe('live');
  });

  test('inserts a supersedes edge from newer to older on dedup', () => {
    const id1 = ulid();
    const id2 = ulid();
    insertFileChunk(id1, 'file:///edge.ts', 0);
    insertFileChunk(id2, 'file:///edge.ts', 1000); // id2 newer

    insertEmbedding(id1, [1, 0, 0, 0]);
    insertEmbedding(id2, [1, 0, 0, 0]);

    runDedupeWalker(db, cfg);

    // id2 (newer) supersedes id1 (older)
    const edges = getEdgesFrom(db, id2);
    expect(edges.length).toBe(1);
    expect(edges[0].kind).toBe('supersedes');
    expect(edges[0].dst_id).toBe(id1);
  });

  test('does not touch nodes of different source_uri', () => {
    const id1 = ulid();
    const id2 = ulid();
    insertFileChunk(id1, 'file:///a.ts');
    insertFileChunk(id2, 'file:///b.ts'); // different source_uri

    // Identical embeddings but different source_uri — should NOT dedupe
    insertEmbedding(id1, [1, 0, 0, 0]);
    insertEmbedding(id2, [1, 0, 0, 0]);

    runDedupeWalker(db, cfg);

    const r1 = db.query(`SELECT status FROM nodes WHERE id = ?`).get(id1) as { status: string };
    const r2 = db.query(`SELECT status FROM nodes WHERE id = ?`).get(id2) as { status: string };
    expect(r1.status).toBe('live');
    expect(r2.status).toBe('live');
  });
});
