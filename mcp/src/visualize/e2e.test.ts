import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { openDb, closeDb } from '../store/db.js';
import { insertNode } from '../store/nodes.js';
import { insertEdge } from '../store/edges.js';
import { VisualizeServer } from './server.js';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';

let tmpDir: string;
let db: Database;
let srv: VisualizeServer;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'memtree-e2e-'));
  db = openDb(join(tmpDir, 'test.db'));
  srv = new VisualizeServer(db, { port: 0 });
  await srv.start();
});

afterEach(async () => {
  await srv.stop();
  closeDb(db);
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeNode(id = ulid()) {
  const content = 'e2e content';
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

function connectWs(msgTimeout = 4000) {
  const queue: any[] = [];
  const waiters: Array<(msg: any) => void> = [];
  const url = srv.url.replace('http://', 'ws://') + '/api/events';
  const ws = new WebSocket(url);

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data as string);
    if (waiters.length > 0) {
      waiters.shift()!(msg);
    } else {
      queue.push(msg);
    }
  });

  function next(): Promise<any> {
    return new Promise((resolve, reject) => {
      if (queue.length > 0) { resolve(queue.shift()); return; }
      const t = setTimeout(() => reject(new Error('WS message timeout')), msgTimeout);
      waiters.push((msg) => { clearTimeout(t); resolve(msg); });
    });
  }

  function ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (ws.readyState === WebSocket.OPEN) { resolve(); return; }
      const t = setTimeout(() => reject(new Error('WS connect timeout')), msgTimeout);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
    });
  }

  return { ws, next, ready };
}

describe('VisualizeServer E2E — WebSocket', () => {
  test('sends snapshot containing existing nodes on connect', async () => {
    const id = makeNode();
    const { ready, next, ws } = connectWs();
    await ready();

    const msg = await next();
    ws.close();

    expect(msg.op).toBe('snapshot');
    expect(Array.isArray(msg.nodes)).toBe(true);
    expect(Array.isArray(msg.edges)).toBe(true);
    expect(msg.nodes.some((n: any) => n.id === id)).toBe(true);
  });

  test('sends empty snapshot when db is empty', async () => {
    const { ready, next, ws } = connectWs();
    await ready();

    const msg = await next();
    ws.close();

    expect(msg.op).toBe('snapshot');
    expect(msg.nodes).toHaveLength(0);
    expect(msg.edges).toHaveLength(0);
  });

  test('broadcasts node insert delta after connect', async () => {
    const { ready, next, ws } = connectWs();
    await ready();
    await next(); // consume snapshot

    const id = makeNode();
    const delta = await next();
    ws.close();

    expect(delta.op).toBe('insert');
    expect(delta.table).toBe('nodes');
    expect(delta.id).toBe(id);
    expect(delta.data.kind).toBe('note');
  });

  test('broadcasts node update delta when status changes', async () => {
    const id = makeNode();
    await sleep(500); // let DbWatcher seed this node before connecting

    const { ready, next, ws } = connectWs();
    await ready();
    await next(); // consume snapshot

    db.run('UPDATE nodes SET status = ?, updated_at = ? WHERE id = ?', 'stale', Date.now(), id);
    const delta = await next();
    ws.close();

    expect(delta.op).toBe('update');
    expect(delta.table).toBe('nodes');
    expect(delta.id).toBe(id);
    expect(delta.data.status).toBe('stale');
  });

  test('broadcasts edge insert delta', async () => {
    const id1 = makeNode();
    const id2 = makeNode();
    await sleep(500); // let DbWatcher seed both nodes

    const { ready, next, ws } = connectWs();
    await ready();
    await next(); // consume snapshot

    insertEdge(db, { src_id: id1, dst_id: id2, kind: 'follows' });
    const delta = await next();
    ws.close();

    expect(delta.op).toBe('insert');
    expect(delta.table).toBe('edges');
    expect(delta.data.src_id).toBe(id1);
    expect(delta.data.dst_id).toBe(id2);
  });

  test('delivers deltas to multiple concurrent clients', async () => {
    const c1 = connectWs();
    const c2 = connectWs();
    await Promise.all([c1.ready(), c2.ready()]);
    await Promise.all([c1.next(), c2.next()]); // consume snapshots

    const id = makeNode();
    const [d1, d2] = await Promise.all([c1.next(), c2.next()]);
    c1.ws.close();
    c2.ws.close();

    expect(d1.id).toBe(id);
    expect(d2.id).toBe(id);
    expect(d1.op).toBe('insert');
    expect(d2.op).toBe('insert');
  });

  test('new client receives correct snapshot after deltas were emitted', async () => {
    // Insert a node before connecting the second client
    const id = makeNode();
    await sleep(500); // let DbWatcher process the insert

    const { ready, next, ws } = connectWs();
    await ready();

    const msg = await next();
    ws.close();

    expect(msg.op).toBe('snapshot');
    expect(msg.nodes.some((n: any) => n.id === id)).toBe(true);
  });
});
