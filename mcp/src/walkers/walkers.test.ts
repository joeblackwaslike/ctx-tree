import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync, existsSync } from 'fs';
import { openDb, closeDb } from '../store/db';
import { insertNode, getNode } from '../store/nodes';
import { runFilterWalker } from './filter';
import { runStalenessWalker } from './staleness';
import { runPrunerWalker } from './pruner';
import { ulid } from 'ulid';
import { DEFAULT_CONFIG } from '../config';
import type { Database } from 'bun:sqlite';

const TEST_DB = '/tmp/memtree-walkers-test.db';
let db: Database;
const cfg = DEFAULT_CONFIG;

beforeEach(() => { db = openDb(TEST_DB); });
afterEach(() => {
  closeDb(db);
  for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm'])
    if (existsSync(f)) unlinkSync(f);
});

describe('filter walker', () => {
  test('promotes pending node to live', () => {
    const id = ulid();
    insertNode(db, id, {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'this is long enough content', content_hash: 'h1',
      status: 'pending', mtime: 0, truncated: 0, original_bytes: 27, metadata: '{}',
    });
    runFilterWalker(db, cfg);
    expect(getNode(db, id)!.status).toBe('live');
  });

  test('drops pending node below filterMinSize', () => {
    const id = ulid();
    insertNode(db, id, {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'tiny', content_hash: 'h2',
      status: 'pending', mtime: 0, truncated: 0, original_bytes: 4, metadata: '{}',
    });
    runFilterWalker(db, cfg);
    const node = getNode(db, id);
    expect(node?.status ?? 'pruned').toBe('pruned');
  });
});

describe('filter walker batch', () => {
  test('processes multiple pending nodes in one pass', () => {
    for (let i = 0; i < 5; i++) {
      insertNode(db, ulid(), {
        parent_id: null, kind: 'note', source_uri: null,
        content: `content long enough to pass filter ${i}`, content_hash: `hash${i}`,
        status: 'pending', mtime: 0, truncated: 0, original_bytes: 40, metadata: '{}',
      });
    }
    runFilterWalker(db, cfg);
    const live = (db.query("SELECT COUNT(*) as n FROM nodes WHERE status='live'").get() as { n: number }).n;
    expect(live).toBe(5);
  });
});

describe('coordinator startup sweep', () => {
  test('processes pre-existing pending rows on start', () => {
    insertNode(db, ulid(), {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'leftover pending from crashed session xyz',
      content_hash: 'leftover1', status: 'pending',
      mtime: 0, truncated: 0, original_bytes: 42, metadata: '{}',
    });
    const { WalkerCoordinator } = require('./coordinator');
    const coord = new WalkerCoordinator();
    coord.startupSweep(db, cfg);
    coord.stop();
    const pending = (db.query("SELECT COUNT(*) as n FROM nodes WHERE status='pending'").get() as { n: number }).n;
    expect(pending).toBe(0);
  });
});

describe('pruner walker', () => {
  test('prunes stale nodes older than retention horizon', () => {
    const id = ulid();
    const oldTime = Date.now() - (48 * 60 * 60 * 1000); // 48h ago
    insertNode(db, id, {
      parent_id: null, kind: 'note', source_uri: null,
      content: 'stale content', content_hash: 'h3',
      status: 'stale', mtime: 0, truncated: 0, original_bytes: 13, metadata: '{}',
    });
    db.run('UPDATE nodes SET updated_at = ? WHERE id = ?', oldTime, id);
    runPrunerWalker(db, cfg);
    expect(getNode(db, id)!.status).toBe('pruned');
  });
});
