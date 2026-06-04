// mcp/src/visualize/watcher.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { openDb, closeDb } from '../store/db.js';
import { insertNode } from '../store/nodes.js';
import { insertEdge } from '../store/edges.js';
import { DbWatcher } from './watcher.js';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';

let tmpDir: string;
let db: Database;
let watcher: DbWatcher;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ctx-tree-watcher-test-'));
  db = openDb(join(tmpDir, 'test.db'));
  watcher = new DbWatcher(db, 50); // 50ms poll for fast tests
});

afterEach(() => {
  watcher.stop();
  closeDb(db);
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeNode(id = ulid()) {
  const content = 'test content';
  insertNode(db, id, {
    parent_id: null,
    kind: 'note',
    source_uri: null,
    content,
    content_hash: createHash('sha256').update(content).digest('hex'),
    status: 'live',
    mtime: 0,
    truncated: 0,
    original_bytes: content.length,
    metadata: '{}',
  });
  return id;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

describe('DbWatcher', () => {
  test('emits insert event with node data when a node is inserted', async () => {
    const events: any[] = [];
    watcher.on(e => events.push(e));

    const id = makeNode();
    await sleep(120); // wait 2+ poll cycles

    const insert = events.find(e => e.op === 'insert' && e.table === 'nodes' && e.id === id);
    expect(insert).toBeTruthy();
    expect(insert.data.kind).toBe('note');
  });

  test('emits update event when a node status changes', async () => {
    const id = makeNode();
    await sleep(120); // let insert be picked up

    const events: any[] = [];
    watcher.on(e => events.push(e));

    db.run('UPDATE nodes SET status = ?, updated_at = ? WHERE id = ?', 'stale', Date.now(), id);
    await sleep(120);

    const update = events.find(e => e.op === 'update' && e.id === id);
    expect(update).toBeTruthy();
    expect(update.data.status).toBe('stale');
  });

  test('unsubscribing stops receiving events', async () => {
    const events: any[] = [];
    const off = watcher.on(e => events.push(e));
    off();

    makeNode();
    await sleep(120);
    expect(events).toHaveLength(0);
  });

  test('does not emit events for nodes that existed before start', async () => {
    const id = makeNode(); // insert BEFORE registering listener
    await sleep(120);

    const events: any[] = [];
    watcher.on(e => events.push(e)); // starts watcher, seeds known IDs

    await sleep(120);
    // No events — the node was already known
    expect(events.filter(e => e.id === id)).toHaveLength(0);
  });

  test('emits insert event for edges', async () => {
    const id1 = makeNode();
    const id2 = makeNode();
    await sleep(120);

    const events: any[] = [];
    watcher.on(e => events.push(e));

    insertEdge(db, { src_id: id1, dst_id: id2, kind: 'follows' });
    await sleep(120);

    const edgeEvent = events.find(e => e.table === 'edges' && e.op === 'insert');
    expect(edgeEvent).toBeTruthy();
    expect(edgeEvent.data.src_id).toBe(id1);
    expect(edgeEvent.data.dst_id).toBe(id2);
  });
});
