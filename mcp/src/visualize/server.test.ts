import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { openDb, closeDb } from '../store/db.js';
import { insertNode } from '../store/nodes.js';
import { VisualizeServer } from './server.js';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';

let tmpDir: string;
let db: Database;
let srv: VisualizeServer;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ctx-tree-viz-test-'));
  db = openDb(join(tmpDir, 'test.db'));
  srv = new VisualizeServer(db, { port: 0 });
});

afterEach(async () => {
  await srv.stop();
  closeDb(db);
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeNode(id = ulid()) {
  const content = 'test';
  insertNode(db, id, {
    parent_id: null, kind: 'note', source_uri: null, content,
    content_hash: createHash('sha256').update(content).digest('hex'),
    status: 'live', mtime: 0, truncated: 0, original_bytes: 4, metadata: '{}',
  });
  return id;
}

describe('VisualizeServer', () => {
  test('GET /health returns ok with node/edge counts', async () => {
    await srv.start();
    makeNode();
    const res = await fetch(`${srv.url}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe('ok');
    expect(body.nodeCount).toBeGreaterThanOrEqual(1);
    expect(body.edgeCount).toBeGreaterThanOrEqual(0);
  });

  test('GET /api/state returns nodes and edges arrays', async () => {
    await srv.start();
    const id = makeNode();
    const res = await fetch(`${srv.url}/api/state`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.edges)).toBe(true);
    expect(body.nodes.some((n: any) => n.id === id)).toBe(true);
  });

  test('GET /api/state filters by kind query param', async () => {
    await srv.start();
    makeNode();
    const res = await fetch(`${srv.url}/api/state?kind=note`);
    const body = await res.json() as any;
    expect(body.nodes.every((n: any) => n.kind === 'note')).toBe(true);
  });

  test('GET /api/node/:id returns node data', async () => {
    await srv.start();
    const id = makeNode();
    const res = await fetch(`${srv.url}/api/node/${id}`);
    expect(res.status).toBe(200);
    const node = await res.json() as any;
    expect(node.id).toBe(id);
    expect(node.kind).toBe('note');
  });

  test('GET /api/node/:id returns 404 for unknown id', async () => {
    await srv.start();
    const res = await fetch(`${srv.url}/api/node/nonexistent`);
    expect(res.status).toBe(404);
  });

  test('GET / returns HTML', async () => {
    await srv.start();
    const res = await fetch(srv.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  test('start() is idempotent — calling twice returns same port', async () => {
    const first = await srv.start();
    const second = await srv.start();
    expect(first.port).toBe(second.port);
  });
});
