import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync, existsSync } from 'fs';
import { openDb, closeDb } from '../store/db';
import { insertNode, getNode } from '../store/nodes';
import { createSqliteBackend } from '../store/backends/sqlite/index.js';
import { runFilterWalker } from './filter';
import { runPrunerWalker } from './pruner';
import { ulid } from 'ulid';
import { DEFAULT_CONFIG } from '../config';
import type { Database } from 'bun:sqlite';
import type { StoreBackend } from '../store/index.js';

const TEST_DB = '/tmp/memtree-walkers-test.db';
let db: Database;
let store: StoreBackend;
const cfg = DEFAULT_CONFIG;

beforeEach(async () => {
  db = openDb(TEST_DB);
  store = await createSqliteBackend(TEST_DB);
});
afterEach(async () => {
  await store.close();
  closeDb(db);
  for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm'])
    if (existsSync(f)) unlinkSync(f);
});

describe('filter walker', () => {
  test('promotes pending node to live', async () => {
    const id = ulid();
    insertNode(db, id, {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'this is long enough content, padded sufficiently here', content_hash: 'h1',
      status: 'pending', mtime: 0, truncated: 0, original_bytes: 53, metadata: '{}',
    });
    await runFilterWalker(store, cfg);
    expect(getNode(db, id)!.status).toBe('live');
  });

  test('drops pending node below filterMinSize', async () => {
    const id = ulid();
    insertNode(db, id, {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'tiny', content_hash: 'h2',
      status: 'pending', mtime: 0, truncated: 0, original_bytes: 4, metadata: '{}',
    });
    await runFilterWalker(store, cfg);
    const node = getNode(db, id);
    expect(node?.status ?? 'pruned').toBe('pruned');
  });
});

describe('filter walker batch', () => {
  test('processes multiple pending nodes in one pass', async () => {
    for (let i = 0; i < 5; i++) {
      insertNode(db, ulid(), {
        parent_id: null, kind: 'note', source_uri: null,
        content: `content long enough to pass the full filter check here: ${i}`, content_hash: `hash${i}`,
        status: 'pending', mtime: 0, truncated: 0, original_bytes: 57, metadata: '{}',
      });
    }
    await runFilterWalker(store, cfg);
    const live = (db.query("SELECT COUNT(*) as n FROM nodes WHERE status='live'").get() as { n: number }).n;
    expect(live).toBe(5);
  });
});

describe('coordinator startup sweep', () => {
  test('processes pre-existing pending rows on start', async () => {
    insertNode(db, ulid(), {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'leftover pending from crashed session xyz, padded to 56 chars',
      content_hash: 'leftover1', status: 'pending',
      mtime: 0, truncated: 0, original_bytes: 61, metadata: '{}',
    });
    const { WalkerCoordinator } = require('./coordinator');
    const coord = new WalkerCoordinator();
    await coord.startupSweep(store, cfg);
    coord.stop();
    const pending = (db.query("SELECT COUNT(*) as n FROM nodes WHERE status='pending'").get() as { n: number }).n;
    expect(pending).toBe(0);
  });
});

describe('filter walker deduplication', () => {
  test('prunes duplicate pending node when live node with same hash exists', async () => {
    const liveId = ulid();
    insertNode(db, liveId, {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'shared content that is long enough to pass the size check here',
      content_hash: 'shared-hash', status: 'live',
      mtime: 0, truncated: 0, original_bytes: 62, metadata: '{}',
    });
    const dupId = ulid();
    insertNode(db, dupId, {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'shared content that is long enough to pass the size check here',
      content_hash: 'shared-hash', status: 'pending',
      mtime: 0, truncated: 0, original_bytes: 62, metadata: '{}',
    });
    await runFilterWalker(store, cfg);
    const dup = getNode(db, dupId);
    expect(dup?.status ?? 'pruned').toBe('pruned');
    expect(getNode(db, liveId)!.status).toBe('live');
  });
});

describe('pruner walker', () => {
  test('prunes stale nodes older than retention horizon', async () => {
    const id = ulid();
    const oldTime = Date.now() - (48 * 60 * 60 * 1000); // 48h ago
    insertNode(db, id, {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'stale content', content_hash: 'h3',
      status: 'stale', mtime: 0, truncated: 0, original_bytes: 13, metadata: '{}',
    });
    db.run('UPDATE nodes SET updated_at = ? WHERE id = ?', oldTime, id);
    await runPrunerWalker(store, cfg);
    expect(getNode(db, id)!.status).toBe('pruned');
  });
});
