# ctx-tree Visualizer — Design Spec

**Date:** 2026-05-28
**Status:** Approved

## Overview

A real-time web-based graph visualizer for the ctx-tree SQLite store. A lazy-start HTTP + WebSocket server embedded in the MCP server process exposes the live property graph to a browser (or VS Code webview). Changes appear in the browser within a single event loop tick of the write — no polling.

---

## Architecture

Three layers, cleanly separated so the server module is reusable by a future VS Code extension:

```
mcp/src/visualize/
  server.ts    — VisualizeServer class (HTTP + WebSocket + static HTML)
  watcher.ts   — wraps db.onUpdate hook, emits typed ChangeEvent to listeners
  ui.html      — self-contained frontend (D3 v7 inlined, no CDN deps)

mcp/src/tools/
  visualize.ts — MCP tool: lazy-starts VisualizeServer, returns URL
```

**`VisualizeServer`** has no MCP coupling. Constructor signature:

```ts
new VisualizeServer(db: Database, options?: { port?: number; host?: string })
```

The VS Code extension will import it, open its own `openDb(dbPath, { readonly: true })`, and pass the `Database` object in. The frontend HTML works identically served over HTTP or embedded in a VS Code webview (no CDN, no external resources).

---

## Change Watcher (`watcher.ts`)

Wraps `db.onUpdate(callback)` from `bun:sqlite`. The callback fires synchronously in the same process as every write, giving sub-millisecond latency.

```ts
type ChangeEvent =
  | { op: 'insert' | 'update', table: 'nodes', id: string, data: CtxTreeNode }
  | { op: 'delete', table: 'nodes', id: string }
  | { op: 'insert', table: 'edges', id: string, data: CtxTreeEdge }
  | { op: 'delete', table: 'edges', id: string };
```

On each `onUpdate` callback:

- Look up the changed row by rowid (`SELECT * FROM nodes WHERE rowid = ?`)
- Emit typed `ChangeEvent` to registered listeners
- `VisualizeServer` registers one listener that broadcasts to all open WebSocket clients

Only `nodes` and `edges` tables are watched. FTS and `nodes_vec` updates are ignored (they're derived from `nodes` writes and would double-fire).

---

## HTTP + WebSocket API

All endpoints served by a Bun `Bun.serve()` HTTP server.

| Endpoint | Method | Purpose |
|---|---|---|
| `/` | GET | Serves `ui.html` |
| `/api/state` | GET | Full snapshot — `{ nodes: CtxTreeNode[], edges: CtxTreeEdge[] }`. Query params: `session_id`, `kind`, `status` (comma-separated for multi). |
| `/api/node/:id` | GET | Single node with full content. Used by right panel on click. |
| `/api/events` | WS upgrade | WebSocket stream of change events. |
| `/health` | GET | `{ status: 'ok', nodeCount: number, edgeCount: number }` |

### WebSocket protocol

**On connection:** Server sends one snapshot message, then streams deltas.

```ts
// snapshot (sent once on connect)
{ op: 'snapshot', nodes: CtxTreeNode[], edges: CtxTreeEdge[] }

// delta (sent on every db change)
{ op: 'insert' | 'update' | 'delete', table: 'nodes' | 'edges', id: string, data?: CtxTreeNode | CtxTreeEdge }
```

Snapshot applies the current `status: live` filter by default. Browser builds its graph from the snapshot and patches it on each delta — no polling, no full re-renders.

---

## MCP Tool (`ctx_tree_visualize`)

Registered alongside the existing tools in `server.ts`.

**Input schema:**

```ts
{ port?: number, open?: boolean }
```

**Behavior:**

- Module-level singleton `vizServer: VisualizeServer | null = null`
- If `vizServer` is null, construct and start it
- Port resolution: `CTX_TREE_VIZ_PORT` env → `port` arg → `7777`; if taken, increment until a free port is found (max 10 attempts)
- If `open` is `true` (default): call `open <url>` (macOS) / `xdg-open <url>` (Linux) to launch the browser
- If server is already running, skip construction and just return the URL (idempotent)

**Return value:**

```ts
{ url: string, port: number, nodeCount: number, edgeCount: number }
```

`open: false` suppresses browser launch — used in VS Code where the webview handles display.

---

## Frontend (`ui.html`)

Single self-contained file (~700 lines HTML/CSS/JS). D3 v7 bundled inline. No network requests after initial load — works in VS Code webview sandbox.

### Layout (A1)

```
┌──────────────────────────────────────────────────────┐
│ 🌳  [Graph] [Timeline] [Feed]  session▾ kind▾  ● live│
├────────────────────────────────────┬─────────────────┤
│                                    │  node detail    │
│           active view              │  panel          │
│        (graph / timeline           │  (260px fixed)  │
│            / feed)                 │                 │
└────────────────────────────────────┴─────────────────┘
```

### Graph view

- D3 force-directed simulation
- Node color by kind (matches `how-it-works.html` palette)
- Edge color by edge kind; arrowheads indicating direction
- New node: brief pulse animation on insert
- Deleted node: fade-out, then remove from simulation
- Click node → populates right panel
- Drag to reposition; scroll to zoom

### Timeline view

- Horizontal axis: `created_at` (oldest left, newest right)
- Rows: one per node kind
- Nodes rendered as dots/chips; click → right panel
- Useful for seeing the sequence of a session at a glance

### Feed view

- Scrolling event log, newest at top
- Format: `[HH:MM:SS] + insert  file_chunk  src/tools/read.ts`
- Color-coded by op: green insert, yellow update, red delete
- Auto-scrolls unless user has manually scrolled up (scroll lock)

### Right panel

Always visible regardless of active view tab. Sections:

- Kind badge + node ID (truncated ULID)
- `source_uri` (if present, clickable path)
- `status` pill (live / stale / pruned / etc.)
- `created_at` / `updated_at` timestamps
- Metadata key-value pairs (expanded from JSON blob)
- Content preview (first 500 chars, monospace)
- Outgoing edges list (`→ follows ×3`, `→ derived_from ×1`)
- Incoming edges list (`← summarizes ×0`)

### WebSocket lifecycle

- Connects on page load; shows `● live` in toolbar when open
- On snapshot message: renders full graph, populates all views
- On delta: patches D3 data, gently restarts simulation (alpha 0.1, not full reheat)
- On disconnect: shows `○ disconnected` + auto-retries every 3s

---

## VS Code Reuse Path

The VS Code extension will:

1. Import `VisualizeServer` from the compiled MCP package (or a shared `@ctx-tree/visualize` sub-package extracted later)
2. Resolve `dbPath` from `~/.ctx-tree/<projectHash>/store.db` using `computeProjectHash(workspaceRoot)`
3. Open the DB directly: `new Database(dbPath, { readonly: true })` from `bun:sqlite` (bypasses `openDb` to avoid schema migrations on a read-only connection)
4. Construct `new VisualizeServer(db, { port })` and call `.start()`
5. Either (a) load the returned URL in a webview, or (b) serve `ui.html` directly from the extension

No protocol changes are needed — the webview speaks the same WebSocket API.

---

## File Summary

| File | Action |
|---|---|
| `mcp/src/visualize/watcher.ts` | Create — SQLite update hook → typed ChangeEvent emitter |
| `mcp/src/visualize/server.ts` | Create — VisualizeServer class (HTTP + WebSocket) |
| `mcp/src/visualize/ui.html` | Create — self-contained D3 frontend |
| `mcp/src/tools/visualize.ts` | Create — MCP tool handler |
| `mcp/src/server.ts` | Modify — import and register `ctx_tree_visualize` tool |
