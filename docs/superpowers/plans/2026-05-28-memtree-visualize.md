# memtree Visualizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real-time web visualizer to memtree — a lazy-start HTTP+WebSocket server embedded in the MCP process that streams live graph changes to a D3 browser UI.

**Architecture:** `DbWatcher` wraps `db.onUpdate` to emit typed `ChangeEvent`s. `VisualizeServer` serves a self-contained HTML frontend and broadcasts events to WebSocket clients. The MCP tool `memtree_visualize` lazy-starts the server on first call and returns the URL. All three components are decoupled so VS Code can reuse `VisualizeServer` directly.

**Tech Stack:** Bun HTTP server (`Bun.serve`), `bun:sqlite` update hook, D3 v7 (CDN), TypeScript, bun:test

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `mcp/src/visualize/watcher.ts` | Create | SQLite `onUpdate` hook → typed `ChangeEvent` emitter |
| `mcp/src/visualize/server.ts` | Create | `VisualizeServer` class: HTTP + WebSocket + static HTML |
| `mcp/src/visualize/ui.html` | Create | Self-contained D3 frontend (Graph / Timeline / Feed tabs) |
| `mcp/src/tools/visualize.ts` | Create | MCP tool: lazy-start singleton, browser open, return URL |
| `mcp/src/server.ts` | Modify | Import + register `memtree_visualize` tool |
| `mcp/package.json` | Modify | Add `cp ui.html` to build script |
| `mcp/src/visualize/watcher.test.ts` | Create | Unit tests for `DbWatcher` change events |
| `mcp/src/visualize/server.test.ts` | Create | HTTP endpoint tests for `VisualizeServer` |

---

## Task 1: `DbWatcher` — SQLite change event emitter

**Files:**
- Create: `mcp/src/visualize/watcher.ts`
- Create: `mcp/src/visualize/watcher.test.ts`

### Step 1.1 — Write the failing tests

```ts
// mcp/src/visualize/watcher.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { openDb, closeDb } from '../store/db.js';
import { insertNode } from '../store/nodes.js';
import { insertEdge } from '../store/edges.js';
import { DbWatcher } from './watcher.js';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';

let tmpDir: string;
let db: Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'memtree-watcher-test-'));
  db = openDb(join(tmpDir, 'test.db'));
});

afterEach(() => {
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

describe('DbWatcher', () => {
  test('emits insert event with node data when a node is inserted', () => {
    const watcher = new DbWatcher(db);
    const events: any[] = [];
    watcher.on(e => events.push(e));

    const id = makeNode();

    expect(events).toHaveLength(1);
    expect(events[0].op).toBe('insert');
    expect(events[0].table).toBe('nodes');
    expect(events[0].id).toBe(id);
    expect(events[0].data.kind).toBe('note');
  });

  test('emits delete event with correct id when a node is deleted', () => {
    const watcher = new DbWatcher(db);
    const id = makeNode(); // insert after watcher is created so cache is populated

    const events: any[] = [];
    watcher.on(e => events.push(e));

    db.run('DELETE FROM nodes WHERE id = ?', id);

    const deleteEvent = events.find(e => e.op === 'delete' && e.table === 'nodes');
    expect(deleteEvent).toBeTruthy();
    expect(deleteEvent.id).toBe(id);
  });

  test('unsubscribing stops receiving events', () => {
    const watcher = new DbWatcher(db);
    const events: any[] = [];
    const off = watcher.on(e => events.push(e));
    off();

    makeNode();
    expect(events).toHaveLength(0);
  });

  test('ignores changes to FTS and vec tables', () => {
    const watcher = new DbWatcher(db);
    const events: any[] = [];
    watcher.on(e => events.push(e));

    makeNode(); // triggers nodes + nodes_fts triggers

    // Only the nodes insert should appear — not the FTS shadow table writes
    expect(events.every(e => e.table === 'nodes' || e.table === 'edges')).toBe(true);
    expect(events).toHaveLength(1);
  });

  test('emits insert event for edges', () => {
    const watcher = new DbWatcher(db);
    const id1 = makeNode();
    const id2 = makeNode();

    const events: any[] = [];
    watcher.on(e => events.push(e));

    insertEdge(db, id1, id2, 'follows');

    const edgeEvent = events.find(e => e.table === 'edges');
    expect(edgeEvent).toBeTruthy();
    expect(edgeEvent.op).toBe('insert');
    expect(edgeEvent.data.src_id).toBe(id1);
    expect(edgeEvent.data.dst_id).toBe(id2);
  });
});
```

- [ ] **Step 1.2 — Run tests to verify they fail**

```bash
cd mcp && bun test src/visualize/watcher.test.ts
```

Expected: errors importing `./watcher.js`

- [ ] **Step 1.3 — Check `insertEdge` signature**

```bash
cd mcp && grep -n 'export function insertEdge' src/store/edges.ts
```

Note the exact signature — use it in the implementation below.

- [ ] **Step 1.4 — Create `watcher.ts`**

```ts
// mcp/src/visualize/watcher.ts
import type { Database } from 'bun:sqlite';
import type { MemtreeNode, MemtreeEdge } from '../store/types.js';

export type ChangeEvent =
  | { op: 'insert' | 'update'; table: 'nodes'; id: string; data: MemtreeNode }
  | { op: 'delete'; table: 'nodes'; id: string }
  | { op: 'insert'; table: 'edges'; id: string; data: MemtreeEdge }
  | { op: 'delete'; table: 'edges'; id: string };

export type ChangeListener = (event: ChangeEvent) => void;

const WATCHED = new Set(['nodes', 'edges']);

export class DbWatcher {
  private listeners = new Set<ChangeListener>();
  // rowid cache so DELETE events carry the correct application-level id
  private nodeRowids = new Map<number, string>();   // rowid → node.id
  private edgeRowids = new Map<number, string>();   // rowid → "src:dst:kind"

  constructor(private db: Database) {
    // Seed cache from existing rows
    for (const r of db.query<{ rowid: number; id: string }, []>('SELECT rowid, id FROM nodes').all()) {
      this.nodeRowids.set(r.rowid, r.id);
    }
    for (const r of db.query<{ rowid: number; src_id: string; dst_id: string; kind: string }, []>(
      'SELECT rowid, src_id, dst_id, kind FROM edges'
    ).all()) {
      this.edgeRowids.set(r.rowid, `${r.src_id}:${r.dst_id}:${r.kind}`);
    }

    db.onUpdate((type, _database, table, rowid) => {
      if (!WATCHED.has(table)) return;
      const op = type as 'insert' | 'update' | 'delete';

      if (op === 'delete') {
        if (table === 'nodes') {
          const id = this.nodeRowids.get(rowid) ?? String(rowid);
          this.nodeRowids.delete(rowid);
          this.emit({ op: 'delete', table: 'nodes', id });
        } else {
          const id = this.edgeRowids.get(rowid) ?? String(rowid);
          this.edgeRowids.delete(rowid);
          this.emit({ op: 'delete', table: 'edges', id });
        }
        return;
      }

      if (table === 'nodes') {
        const row = db.query<MemtreeNode, [number]>('SELECT * FROM nodes WHERE rowid = ?').get(rowid);
        if (!row) return;
        this.nodeRowids.set(rowid, row.id);
        this.emit({ op, table: 'nodes', id: row.id, data: row });
      } else {
        const row = db.query<MemtreeEdge & { rowid: number }, [number]>(
          'SELECT rowid, * FROM edges WHERE rowid = ?'
        ).get(rowid);
        if (!row) return;
        const compositeId = `${row.src_id}:${row.dst_id}:${row.kind}`;
        this.edgeRowids.set(rowid, compositeId);
        const { rowid: _rowid, ...edge } = row as MemtreeEdge & { rowid: number };
        this.emit({ op: op as 'insert', table: 'edges', id: compositeId, data: edge });
      }
    });
  }

  on(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ChangeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
```

- [ ] **Step 1.5 — Run tests to verify they pass**

```bash
cd mcp && bun test src/visualize/watcher.test.ts
```

Expected: all 5 tests PASS

- [ ] **Step 1.6 — Commit**

```bash
git add mcp/src/visualize/watcher.ts mcp/src/visualize/watcher.test.ts
git commit -m "feat(visualize): add DbWatcher — SQLite onUpdate hook to typed ChangeEvent emitter"
```

---

## Task 2: `VisualizeServer` — HTTP + WebSocket server

**Files:**
- Create: `mcp/src/visualize/server.ts`
- Create: `mcp/src/visualize/server.test.ts`

- [ ] **Step 2.1 — Write failing HTTP tests**

```ts
// mcp/src/visualize/server.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { openDb, closeDb } from '../store/db.js';
import { insertNode } from '../store/nodes.js';
import { VisualizeServer } from './server.js';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';

let tmpDir: string;
let db: Database;
let srv: VisualizeServer;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'memtree-viz-test-'));
  db = openDb(join(tmpDir, 'test.db'));
  // Use port 0 to let OS assign a free port
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
    const id = makeNode();
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
```

- [ ] **Step 2.2 — Run tests to verify they fail**

```bash
cd mcp && bun test src/visualize/server.test.ts
```

Expected: import error for `./server.js`

- [ ] **Step 2.3 — Create `mcp/src/visualize/server.ts`**

```ts
// mcp/src/visualize/server.ts
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Database } from 'bun:sqlite';
import type { MemtreeNode, MemtreeEdge } from '../store/types.js';
import { DbWatcher } from './watcher.js';

const VALID_STATUSES = new Set(['pending', 'live', 'stale', 'superseded', 'pruned']);
const VALID_KINDS = new Set([
  'session', 'file_chunk', 'tool_output', 'summary', 'note',
  'observation', 'web_chunk', 'prompt', 'thinking', 'response',
]);

export interface VisualizeServerOptions {
  port?: number;
  host?: string;
}

export class VisualizeServer {
  private httpServer: ReturnType<typeof Bun.serve> | null = null;
  private watcher: DbWatcher;
  private clients = new Set<import('bun').ServerWebSocket<unknown>>();
  private ui: string;
  private started = false;

  readonly host: string;
  port: number;

  constructor(private db: Database, options: VisualizeServerOptions = {}) {
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 7777;
    this.watcher = new DbWatcher(db);
    this.ui = readFileSync(join(import.meta.dir, 'ui.html'), 'utf8');
  }

  async start(): Promise<{ url: string; port: number }> {
    if (this.started) return { url: this.url, port: this.port };

    if (this.port === 0) {
      this.port = await findFreePort(7777);
    } else {
      this.port = await findFreePort(this.port);
    }

    const self = this;

    this.httpServer = Bun.serve({
      hostname: this.host,
      port: this.port,
      fetch(req, server) {
        const url = new URL(req.url);

        if (url.pathname === '/api/events') {
          if (server.upgrade(req)) return undefined as unknown as Response;
          return new Response('WebSocket upgrade failed', { status: 400 });
        }
        if (url.pathname === '/' || url.pathname === '') {
          return new Response(self.ui, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }
        if (url.pathname === '/api/state') {
          const { nodes, edges } = self.snapshot(url.searchParams);
          return Response.json({ nodes, edges });
        }
        if (url.pathname.startsWith('/api/node/')) {
          const id = url.pathname.slice('/api/node/'.length);
          const node = self.db
            .query<MemtreeNode, [string]>('SELECT * FROM nodes WHERE id = ?')
            .get(id);
          return node
            ? Response.json(node)
            : new Response('Not found', { status: 404 });
        }
        if (url.pathname === '/health') {
          return Response.json(self.stats());
        }
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open(ws) {
          self.clients.add(ws);
          const { nodes, edges } = self.snapshot(new URLSearchParams());
          ws.send(JSON.stringify({ op: 'snapshot', nodes, edges }));
        },
        message() {},
        close(ws) {
          self.clients.delete(ws);
        },
      },
    });

    this.watcher.on(event => {
      const msg = JSON.stringify(event);
      for (const ws of this.clients) {
        try { ws.send(msg); } catch { /* client disconnected */ }
      }
    });

    this.started = true;
    return { url: this.url, port: this.port };
  }

  get url(): string {
    return `http://localhost:${this.port}`;
  }

  stats(): { status: 'ok'; nodeCount: number; edgeCount: number } {
    const nodeCount =
      (this.db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM nodes').get())?.count ?? 0;
    const edgeCount =
      (this.db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM edges').get())?.count ?? 0;
    return { status: 'ok', nodeCount, edgeCount };
  }

  async stop(): Promise<void> {
    this.httpServer?.stop(true);
    this.httpServer = null;
    this.clients.clear();
    this.started = false;
  }

  private snapshot(params: URLSearchParams): { nodes: MemtreeNode[]; edges: MemtreeEdge[] } {
    const conditions: string[] = [];
    const args: (string | number)[] = [];

    const rawKinds = (params.get('kind') ?? '').split(',').filter(k => VALID_KINDS.has(k));
    if (rawKinds.length) {
      conditions.push(`kind IN (${rawKinds.map(() => '?').join(',')})`);
      args.push(...rawKinds);
    }

    const rawStatuses = (params.get('status') ?? '').split(',').filter(s => VALID_STATUSES.has(s));
    if (rawStatuses.length) {
      conditions.push(`status IN (${rawStatuses.map(() => '?').join(',')})`);
      args.push(...rawStatuses);
    } else {
      conditions.push(`status != 'pruned'`);
    }

    const sessionId = params.get('session_id');
    if (sessionId) {
      conditions.push(`json_extract(metadata, '$.session_id') = ?`);
      args.push(sessionId);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const nodes = this.db
      .query<MemtreeNode, typeof args>(`SELECT * FROM nodes ${where}`)
      .all(...args);
    const edges = this.db
      .query<MemtreeEdge, []>('SELECT * FROM edges')
      .all();

    return { nodes, edges };
  }
}

async function findFreePort(start: number): Promise<number> {
  for (let p = start; p < start + 10; p++) {
    try {
      const s = Bun.serve({ port: p, hostname: '127.0.0.1', fetch: () => new Response('') });
      s.stop(true);
      return p;
    } catch {
      continue;
    }
  }
  throw new Error(`No free port found in range ${start}–${start + 9}`);
}
```

- [ ] **Step 2.4 — Run tests to verify they pass**

```bash
cd mcp && bun test src/visualize/server.test.ts
```

Expected: all 7 tests PASS. If any fail due to `ui.html` missing, create a placeholder first (step 3 creates the real one):

```bash
echo '<!DOCTYPE html><html><body>memtree viz</body></html>' > mcp/src/visualize/ui.html
```

- [ ] **Step 2.5 — Commit**

```bash
git add mcp/src/visualize/server.ts mcp/src/visualize/server.test.ts mcp/src/visualize/ui.html
git commit -m "feat(visualize): add VisualizeServer — HTTP+WebSocket server with snapshot and delta streaming"
```

---

## Task 3: Frontend — `ui.html`

**Files:**
- Modify: `mcp/src/visualize/ui.html` (replace placeholder from Task 2)

No automated tests for the frontend — verified manually in Step 3.4.

- [ ] **Step 3.1 — Write `ui.html`**

Replace the placeholder with the full file:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>memtree viz</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: #080e1a; color: #e2e8f0;
  font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px;
  height: 100vh; display: flex; flex-direction: column; overflow: hidden;
}
/* ── Toolbar ──────────────────────────────────────────────── */
#toolbar {
  background: #1e293b; padding: 7px 12px;
  display: flex; align-items: center; gap: 8px;
  border-bottom: 1px solid #334155; flex-shrink: 0;
}
.logo { color: #38bdf8; font-weight: bold; font-size: 14px; margin-right: 4px; }
.tab {
  background: #0f172a; color: #64748b;
  border: none; border-radius: 4px;
  padding: 4px 12px; cursor: pointer;
  font-family: inherit; font-size: 12px; transition: background .15s;
}
.tab.active { background: #38bdf8; color: #0d1b2e; font-weight: bold; }
.tab:hover:not(.active) { background: #1e293b; color: #94a3b8; }
.filter-select {
  background: #0f172a; color: #94a3b8;
  border: 1px solid #334155; border-radius: 4px;
  padding: 3px 8px; font-family: inherit; font-size: 11px;
}
#ws-status { margin-left: auto; font-size: 11px; }
.live { color: #22c55e; }
.disconnected { color: #ef4444; }
.reconnect-btn {
  background: #38bdf8; color: #0d1b2e;
  border: none; border-radius: 3px;
  padding: 2px 8px; cursor: pointer;
  font-family: inherit; font-size: 10px; margin-left: 6px;
}
/* ── Layout ───────────────────────────────────────────────── */
#main { display: flex; flex: 1; overflow: hidden; }
#view-area { flex: 1; overflow: hidden; position: relative; }
#detail-panel {
  width: 260px; background: #111827;
  border-left: 1px solid #1e293b;
  overflow-y: auto; padding: 12px; flex-shrink: 0;
}
/* ── Graph view ───────────────────────────────────────────── */
#graph-view { width: 100%; height: 100%; }
#graph-view svg { width: 100%; height: 100%; }
/* ── Timeline view ────────────────────────────────────────── */
#timeline-view { padding: 16px; overflow-y: auto; height: 100%; }
.tl-row { margin-bottom: 18px; }
.tl-label {
  color: #64748b; font-size: 10px;
  text-transform: uppercase; letter-spacing: .05em; margin-bottom: 4px;
}
.tl-track {
  position: relative; height: 26px;
  background: #0f172a; border-radius: 4px;
}
.tl-dot {
  position: absolute; top: 50%; transform: translate(-50%,-50%);
  width: 10px; height: 10px; border-radius: 50%; cursor: pointer;
  transition: transform .1s;
}
.tl-dot:hover { transform: translate(-50%,-50%) scale(1.5); }
/* ── Feed view ────────────────────────────────────────────── */
#feed-view { padding: 8px 12px; overflow-y: auto; height: 100%; }
.feed-line { padding: 1px 0; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.op-insert { color: #22c55e; }
.op-update { color: #fbbf24; }
.op-delete { color: #ef4444; }
/* ── Detail panel ─────────────────────────────────────────── */
.d-kind {
  font-size: 11px; font-weight: bold;
  padding: 3px 8px; border-radius: 3px;
  display: inline-block; margin-bottom: 10px;
}
.d-field { margin-bottom: 8px; }
.d-label {
  color: #475569; font-size: 10px;
  text-transform: uppercase; letter-spacing: .05em; margin-bottom: 2px;
}
.d-value { color: #e2e8f0; word-break: break-all; font-size: 12px; }
.d-content {
  background: #0f172a; border-radius: 4px; padding: 8px;
  color: #94a3b8; font-size: 11px; line-height: 1.5;
  white-space: pre-wrap; max-height: 220px; overflow-y: auto;
}
.d-edge-out { color: #38bdf8; font-size: 11px; cursor: pointer; }
.d-edge-out:hover, .d-edge-in:hover { text-decoration: underline; }
.d-edge-in { color: #64748b; font-size: 11px; cursor: pointer; }
.empty-panel { color: #1e293b; text-align: center; margin-top: 48px; font-size: 12px; }
</style>
</head>
<body>

<div id="toolbar">
  <span class="logo">🌳 memtree</span>
  <button class="tab active" onclick="switchView('graph',this)">Graph</button>
  <button class="tab" onclick="switchView('timeline',this)">Timeline</button>
  <button class="tab" onclick="switchView('feed',this)">Feed</button>
  <select class="filter-select" id="f-kind" onchange="applyFilters()">
    <option value="">kind: all</option>
    <option value="session">session</option>
    <option value="file_chunk">file_chunk</option>
    <option value="tool_output">tool_output</option>
    <option value="web_chunk">web_chunk</option>
    <option value="prompt">prompt</option>
    <option value="thinking">thinking</option>
    <option value="response">response</option>
    <option value="note">note</option>
    <option value="observation">observation</option>
    <option value="summary">summary</option>
  </select>
  <select class="filter-select" id="f-status" onchange="applyFilters()">
    <option value="">status: active</option>
    <option value="live">live</option>
    <option value="stale">stale</option>
    <option value="superseded">superseded</option>
    <option value="pruned">pruned</option>
  </select>
  <span id="ws-status"><span class="disconnected">○ connecting…</span></span>
</div>

<div id="main">
  <div id="view-area">
    <div id="graph-view"></div>
    <div id="timeline-view" style="display:none"></div>
    <div id="feed-view" style="display:none"></div>
  </div>
  <div id="detail-panel"><div class="empty-panel">Click a node<br>to inspect it</div></div>
</div>

<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
<script>
// ── Constants ──────────────────────────────────────────────────────────────────
const KIND_COLOR = {
  session:'#a78bfa', file_chunk:'#38bdf8', tool_output:'#fb923c',
  summary:'#fbbf24', note:'#4ade80', observation:'#4ade80',
  web_chunk:'#f472b6', prompt:'#e2e8f0', thinking:'#64748b', response:'#60a5fa',
};
const EDGE_COLOR = {
  derived_from:'#475569', references:'#38bdf8', summarizes:'#fbbf24',
  supersedes:'#ef4444', follows:'#a78bfa',
};
function nodeColor(d) { return KIND_COLOR[d.kind] ?? '#64748b'; }
function nodeR(d) { return d.kind === 'session' ? 11 : d.kind === 'response' || d.kind === 'file_chunk' ? 7 : 5; }

// ── State ──────────────────────────────────────────────────────────────────────
const nodeMap = new Map();  // id → node
let edgeArr = [];
let feedLines = [];
let currentView = 'graph';
let retryTimer = null;

// ── D3 Graph ───────────────────────────────────────────────────────────────────
let svg, g, simulation;

function initGraph() {
  const el = document.getElementById('graph-view');
  const w = el.clientWidth || window.innerWidth - 260;
  const h = el.clientHeight || window.innerHeight - 48;

  svg = d3.select('#graph-view').append('svg');

  const defs = svg.append('defs');
  Object.entries(EDGE_COLOR).forEach(([kind, color]) => {
    defs.append('marker').attr('id','arr-'+kind)
      .attr('viewBox','0 -4 8 8').attr('refX',14).attr('refY',0)
      .attr('markerWidth',5).attr('markerHeight',5).attr('orient','auto')
      .append('path').attr('d','M0,-4L8,0L0,4').attr('fill',color).attr('opacity',.5);
  });

  g = svg.append('g');
  svg.call(d3.zoom().scaleExtent([0.1,4]).on('zoom', e => g.attr('transform', e.transform)));

  simulation = d3.forceSimulation()
    .force('link', d3.forceLink().id(d => d.id).distance(70))
    .force('charge', d3.forceManyBody().strength(-150))
    .force('center', d3.forceCenter(w/2, h/2))
    .force('collision', d3.forceCollide(d => nodeR(d) + 4));
}

function getFilters() {
  return {
    kind: document.getElementById('f-kind').value,
    status: document.getElementById('f-status').value,
  };
}

function visibleNodes() {
  const { kind, status } = getFilters();
  return [...nodeMap.values()].filter(n => {
    if (kind && n.kind !== kind) return false;
    if (status) return n.status === status;
    return n.status !== 'pruned';
  });
}

function renderGraph() {
  if (!svg) initGraph();
  const vn = visibleNodes();
  const vnIds = new Set(vn.map(n => n.id));
  const ve = edgeArr.filter(e => vnIds.has(e.src_id) && vnIds.has(e.dst_id));

  const link = g.selectAll('line.lnk')
    .data(ve, d => `${d.src_id}|${d.dst_id}|${d.kind}`)
    .join(
      en => en.append('line').attr('class','lnk')
        .attr('stroke', d => EDGE_COLOR[d.kind] ?? '#334155')
        .attr('stroke-width',1).attr('stroke-opacity',.35)
        .attr('marker-end', d => `url(#arr-${d.kind})`),
      up => up, ex => ex.remove()
    );

  const node = g.selectAll('circle.nd')
    .data(vn, d => d.id)
    .join(
      en => en.append('circle').attr('class','nd')
        .attr('r', nodeR).attr('fill', nodeColor)
        .attr('stroke','#080e1a').attr('stroke-width',1.5)
        .attr('cursor','pointer')
        .on('click', (_, d) => showDetail(d))
        .call(d3.drag()
          .on('start',(e,d) => { if(!e.active) simulation.alphaTarget(.3).restart(); d.fx=d.x; d.fy=d.y; })
          .on('drag', (e,d) => { d.fx=e.x; d.fy=e.y; })
          .on('end',  (e,d) => { if(!e.active) simulation.alphaTarget(0); d.fx=null; d.fy=null; }))
        .append('title').text(d => `${d.kind}\n${d.source_uri ?? d.id}`),
      up => up.attr('fill', nodeColor).attr('r', nodeR),
      ex => ex.remove()
    );

  const simLinks = ve.map(e => ({ ...e, source: e.src_id, target: e.dst_id }));
  simulation.nodes(vn);
  simulation.force('link').links(simLinks);
  simulation.alpha(0.1).restart();

  simulation.on('tick', () => {
    link.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y)
        .attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);
    node.attr('cx',d=>d.x).attr('cy',d=>d.y);
  });
}

function pulseNode(id) {
  if (!g) return;
  g.selectAll('circle.nd').filter(d => d.id === id)
    .transition().duration(150).attr('r', d => nodeR(d)*2).attr('opacity',.5)
    .transition().duration(600).attr('r', nodeR).attr('opacity',1);
}

// ── Timeline ───────────────────────────────────────────────────────────────────
function renderTimeline() {
  const el = document.getElementById('timeline-view');
  el.innerHTML = '';
  const vn = visibleNodes().sort((a,b) => a.created_at - b.created_at);
  if (!vn.length) { el.innerHTML = '<div style="color:#1e293b;text-align:center;margin-top:40px">No nodes match current filters</div>'; return; }

  const byKind = {};
  vn.forEach(n => (byKind[n.kind] = byKind[n.kind] ?? []).push(n));
  const minT = vn[0].created_at, maxT = vn[vn.length-1].created_at, range = maxT - minT || 1;

  Object.entries(byKind).sort().forEach(([kind, nodes]) => {
    const row = document.createElement('div'); row.className = 'tl-row';
    const lbl = document.createElement('div'); lbl.className = 'tl-label'; lbl.textContent = kind;
    const track = document.createElement('div'); track.className = 'tl-track';
    nodes.forEach(n => {
      const pct = ((n.created_at - minT) / range * 92 + 3);
      const dot = document.createElement('div');
      dot.className = 'tl-dot';
      dot.style.cssText = `left:${pct}%;background:${KIND_COLOR[kind]??'#64748b'}`;
      dot.title = n.source_uri ?? n.id;
      dot.onclick = () => showDetail(n);
      track.appendChild(dot);
    });
    row.appendChild(lbl); row.appendChild(track);
    el.appendChild(row);
  });
}

// ── Feed ───────────────────────────────────────────────────────────────────────
function addFeedLine(op, table, id, data) {
  const ts = new Date().toTimeString().slice(0,8);
  const sym = op === 'insert' ? '+' : op === 'update' ? '~' : '-';
  const label = data ? `${data.kind??''} ${(data.source_uri??id).slice(0,70)}` : id.slice(0,60);
  feedLines.unshift({ op, ts, sym, label });
  if (feedLines.length > 500) feedLines.length = 500;
  if (currentView === 'feed') renderFeed();
}

function renderFeed() {
  const el = document.getElementById('feed-view');
  el.innerHTML = feedLines.map(l =>
    `<div class="feed-line op-${l.op}">[${l.ts}] ${l.sym} ${l.op.padEnd(6)} ${l.label}</div>`
  ).join('');
}

// ── Detail panel ───────────────────────────────────────────────────────────────
function showDetail(node) {
  const color = KIND_COLOR[node.kind] ?? '#64748b';
  let meta = {};
  try { meta = JSON.parse(node.metadata || '{}'); } catch {}
  const outE = edgeArr.filter(e => e.src_id === node.id);
  const inE  = edgeArr.filter(e => e.dst_id === node.id);
  const ts = t => new Date(t).toLocaleString();
  const esc = s => String(s).replace(/</g,'&lt;').replace(/>/g,'&gt;');

  document.getElementById('detail-panel').innerHTML = `
    <span class="d-kind" style="background:${color}22;color:${color}">${node.kind}</span>
    <div class="d-field"><div class="d-label">ID</div><div class="d-value" style="font-size:10px">${node.id}</div></div>
    ${node.source_uri ? `<div class="d-field"><div class="d-label">Source</div><div class="d-value">${esc(node.source_uri)}</div></div>` : ''}
    <div class="d-field"><div class="d-label">Status</div>
      <div class="d-value" style="color:${node.status==='live'?'#22c55e':'#94a3b8'}">${node.status}</div></div>
    <div class="d-field"><div class="d-label">Created</div><div class="d-value">${ts(node.created_at)}</div></div>
    ${Object.entries(meta).filter(([,v])=>v!=null&&v!=='').map(([k,v])=>
      `<div class="d-field"><div class="d-label">${k}</div><div class="d-value">${esc(String(v).slice(0,120))}</div></div>`).join('')}
    ${node.content ? `<div class="d-field"><div class="d-label">Content</div>
      <div class="d-content">${esc(node.content.slice(0,600))}${node.content.length>600?'\n…':''}</div></div>` : ''}
    ${outE.length ? `<div class="d-field"><div class="d-label">Out (${outE.length})</div>${
      outE.map(e=>`<div class="d-edge-out" onclick="fetchAndShow('${e.dst_id}')">→ ${e.kind} ${e.dst_id.slice(0,14)}…</div>`).join('')}</div>` : ''}
    ${inE.length  ? `<div class="d-field"><div class="d-label">In (${inE.length})</div>${
      inE.map(e=>`<div class="d-edge-in" onclick="fetchAndShow('${e.src_id}')">← ${e.kind} ${e.src_id.slice(0,14)}…</div>`).join('')}</div>` : ''}
  `;
}

async function fetchAndShow(id) {
  if (nodeMap.has(id)) { showDetail(nodeMap.get(id)); return; }
  const r = await fetch(`/api/node/${id}`);
  if (r.ok) showDetail(await r.json());
}

// ── View switching ─────────────────────────────────────────────────────────────
function switchView(view, btn) {
  currentView = view;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('graph-view').style.display    = view==='graph'    ? 'block' : 'none';
  document.getElementById('timeline-view').style.display = view==='timeline' ? 'block' : 'none';
  document.getElementById('feed-view').style.display     = view==='feed'     ? 'block' : 'none';
  if (view === 'graph')    renderGraph();
  if (view === 'timeline') renderTimeline();
  if (view === 'feed')     renderFeed();
}

function applyFilters() {
  if (currentView === 'graph')    renderGraph();
  if (currentView === 'timeline') renderTimeline();
}

// ── WebSocket ──────────────────────────────────────────────────────────────────
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/api/events`);

  ws.onopen = () => {
    document.getElementById('ws-status').innerHTML = '<span class="live">● live</span>';
    if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
  };

  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);

    if (msg.op === 'snapshot') {
      nodeMap.clear(); edgeArr.length = 0;
      msg.nodes.forEach(n => nodeMap.set(n.id, n));
      edgeArr.push(...msg.edges);
      renderGraph();
      if (currentView === 'timeline') renderTimeline();
      return;
    }

    if (msg.op === 'insert' || msg.op === 'update') {
      if (msg.table === 'nodes') {
        nodeMap.set(msg.id, msg.data);
        if (currentView === 'graph') { renderGraph(); pulseNode(msg.id); }
        if (currentView === 'timeline') renderTimeline();
      } else {
        edgeArr.push(msg.data);
        if (currentView === 'graph') renderGraph();
      }
      addFeedLine(msg.op, msg.table, msg.id, msg.data);
      return;
    }

    if (msg.op === 'delete') {
      if (msg.table === 'nodes') nodeMap.delete(msg.id);
      else {
        const [src,dst,kind] = msg.id.split(':');
        const i = edgeArr.findIndex(e => e.src_id===src && e.dst_id===dst && e.kind===kind);
        if (i >= 0) edgeArr.splice(i, 1);
      }
      if (currentView === 'graph')    renderGraph();
      if (currentView === 'timeline') renderTimeline();
      addFeedLine('delete', msg.table, msg.id, null);
    }
  };

  ws.onclose = () => {
    document.getElementById('ws-status').innerHTML =
      '<span class="disconnected">○ disconnected <button class="reconnect-btn" onclick="connect()">retry</button></span>';
    if (!retryTimer) retryTimer = setInterval(connect, 3000);
  };

  ws.onerror = () => ws.close();
}

connect();
</script>
</body>
</html>
```

- [ ] **Step 3.2 — Run server tests to confirm they still pass**

```bash
cd mcp && bun test src/visualize/server.test.ts
```

Expected: all 7 tests PASS

- [ ] **Step 3.3 — Update build script to copy `ui.html` to `dist/`**

In `mcp/package.json`, change the `build` script from:
```json
"build": "bun build src/server.ts --target bun --outdir dist --external tree-sitter --external tree-sitter-typescript --external tree-sitter-javascript --external tree-sitter-python --external tree-sitter-rust --external tree-sitter-go --external tree-sitter-bash"
```

To:
```json
"build": "bun build src/server.ts --target bun --outdir dist --external tree-sitter --external tree-sitter-typescript --external tree-sitter-javascript --external tree-sitter-python --external tree-sitter-rust --external tree-sitter-go --external tree-sitter-bash && cp src/visualize/ui.html dist/ui.html"
```

- [ ] **Step 3.4 — Manual browser verification**

Start a temporary test server and open the browser:

```bash
cd mcp && bun run -e "
import { openDb } from './src/store/db.ts';
import { VisualizeServer } from './src/visualize/server.ts';
import { insertNode } from './src/store/nodes.ts';
import { ulid } from 'ulid';
import { createHash } from 'crypto';
const db = openDb('/tmp/viz-test.db');
const srv = new VisualizeServer(db, { port: 7777 });
await srv.start();
console.log('Open:', srv.url);
// seed some nodes
for (let i = 0; i < 5; i++) {
  const id = ulid();
  insertNode(db, id, { parent_id: null, kind: 'note', source_uri: null,
    content: 'node ' + i, content_hash: createHash('sha256').update('node'+i).digest('hex'),
    status: 'live', mtime: 0, truncated: 0, original_bytes: 6, metadata: '{}' });
}
"
```

Open http://localhost:7777 in a browser. Verify:
- Graph view renders 5 nodes
- Timeline shows dots in a row
- Feed shows insert lines
- Clicking a node populates the detail panel
- Tabs switch correctly

Clean up: `rm /tmp/viz-test.db`

- [ ] **Step 3.5 — Commit**

```bash
git add mcp/src/visualize/ui.html mcp/package.json
git commit -m "feat(visualize): add self-contained D3 frontend (Graph/Timeline/Feed + detail panel)"
```

---

## Task 4: `memtree_visualize` MCP tool

**Files:**
- Create: `mcp/src/tools/visualize.ts`

No unit tests needed — the tool is a thin adapter over `VisualizeServer`. Integration tested via Task 5 manual verification.

- [ ] **Step 4.1 — Create `mcp/src/tools/visualize.ts`**

```ts
// mcp/src/tools/visualize.ts
import { spawnSync } from 'child_process';
import type { Database } from 'bun:sqlite';
import { VisualizeServer } from '../visualize/server.js';

let vizServer: VisualizeServer | null = null;

export async function memtreeVisualize(
  db: Database,
  params: { port?: number; open?: boolean }
): Promise<{ url: string; port: number; nodeCount: number; edgeCount: number }> {
  if (!vizServer) {
    const port =
      parseInt(process.env.MEMTREE_VIZ_PORT ?? '', 10) || params.port ?? 7777;
    vizServer = new VisualizeServer(db, { port });
    await vizServer.start();
  }

  const { nodeCount, edgeCount } = vizServer.stats();

  if (params.open !== false) {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawnSync(opener, [vizServer.url], { stdio: 'ignore' });
  }

  return { url: vizServer.url, port: vizServer.port, nodeCount, edgeCount };
}
```

- [ ] **Step 4.2 — Commit**

```bash
git add mcp/src/tools/visualize.ts
git commit -m "feat(visualize): add memtree_visualize MCP tool — lazy-start VisualizeServer, opens browser"
```

---

## Task 5: Register `memtree_visualize` in `server.ts`

**Files:**
- Modify: `mcp/src/server.ts`

- [ ] **Step 5.1 — Add the import**

At the top of `mcp/src/server.ts`, after the existing tool imports (around line 27), add:

```ts
import { memtreeVisualize } from './tools/visualize.js';
```

- [ ] **Step 5.2 — Add tool definition to `ListToolsRequestSchema` handler**

In the `tools: [...]` array inside the `ListToolsRequestSchema` handler, add this entry at the end (before the closing `]`):

```ts
{
  name: 'memtree_visualize',
  description: 'Start (or return the URL of) the real-time graph visualizer. Opens a browser tab showing all nodes and edges with live updates. Idempotent — safe to call multiple times.',
  inputSchema: {
    type: 'object',
    properties: {
      port: { type: 'number', description: 'Port to bind (default: 7777, overridden by MEMTREE_VIZ_PORT env)' },
      open: { type: 'boolean', description: 'Open the browser automatically (default: true)' },
    },
  },
},
```

- [ ] **Step 5.3 — Add case to `CallToolRequestSchema` handler**

In the `switch (name)` block inside the `CallToolRequestSchema` handler, add before the `default:` case:

```ts
case 'memtree_visualize': {
  const { port, open } = args as { port?: number; open?: boolean };
  const result = await memtreeVisualize(db, { port, open });
  return {
    content: [{
      type: 'text',
      text: `Visualizer running at ${result.url}\n${result.nodeCount} nodes · ${result.edgeCount} edges`,
    }],
  };
}
```

- [ ] **Step 5.4 — Run the full test suite**

```bash
cd mcp && bun test
```

Expected: all existing tests pass, plus the new watcher and server tests.

- [ ] **Step 5.5 — Build to verify no type errors**

```bash
cd mcp && bun run build
```

Expected: `dist/server.js` created, `dist/ui.html` copied alongside it. No TypeScript errors.

- [ ] **Step 5.6 — End-to-end manual test**

Start the MCP server in dev mode and call the tool:

```bash
cd mcp && MEMTREE_CWD=$(pwd) bun run src/server.ts &
# In another terminal or via Claude session:
# Call memtree_visualize via the MCP protocol
# Verify: browser opens at http://localhost:7777
# Verify: graph shows nodes from the current session's DB
# Verify: making a new memtree_note call adds a node to the graph in real time
```

- [ ] **Step 5.7 — Commit**

```bash
git add mcp/src/server.ts
git commit -m "feat(visualize): register memtree_visualize tool in MCP server"
```

---

## Self-Review Notes

**Spec coverage check:**
- ✅ `DbWatcher` (watcher.ts) — Task 1
- ✅ `VisualizeServer` HTTP + WebSocket (server.ts) — Task 2
- ✅ Frontend: Layout A1, Graph/Timeline/Feed tabs, right panel, live WS — Task 3
- ✅ Snapshot on WS connect, delta streaming — Task 2 + Task 3
- ✅ MCP tool lazy-start, browser open, idempotent — Task 4
- ✅ Port: env → arg → 7777, max 10 increment — Task 2
- ✅ Register in server.ts — Task 5
- ✅ Build artifact: ui.html copied to dist/ — Task 3
- ✅ VS Code reuse path: `VisualizeServer` accepts `Database`, no MCP coupling — Tasks 2 + 4

**Type consistency:** `ChangeEvent`, `VisualizeServer`, `memtreeVisualize` signatures are consistent across all tasks. `DbWatcher` constructed in `VisualizeServer.constructor` matches Task 1 API.
