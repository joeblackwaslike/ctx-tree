#!/usr/bin/env bun
// @bun
var __require = import.meta.require;

// src/cli.ts
import { parseArgs } from "util";
import { join as join2 } from "path";
import { homedir } from "os";
import { existsSync } from "fs";
import { execSync } from "child_process";
import { createHash } from "crypto";
import { Database } from "bun:sqlite";

// ../../mcp/src/visualize/server.ts
import { readFileSync } from "fs";
import { join } from "path";

// ../../mcp/src/visualize/watcher.ts
class DbWatcher {
  db;
  intervalMs;
  listeners = new Set;
  timer = null;
  lastMs = 0;
  knownNodeIds = new Set;
  knownEdgeIds = new Set;
  nodesSince;
  edgesSince;
  constructor(db, intervalMs = 200) {
    this.db = db;
    this.intervalMs = intervalMs;
    this.nodesSince = db.query("SELECT * FROM nodes WHERE updated_at >= ?");
    this.edgesSince = db.query("SELECT * FROM edges WHERE created_at >= ?");
  }
  start() {
    if (this.timer)
      return;
    this.lastMs = Date.now();
    for (const n of this.db.query("SELECT id FROM nodes").all()) {
      this.knownNodeIds.add(n.id);
    }
    for (const e of this.db.query("SELECT src_id, dst_id, kind FROM edges").all()) {
      this.knownEdgeIds.add(`${e.src_id}:${e.dst_id}:${e.kind}`);
    }
    this.timer = setInterval(() => this._poll(), this.intervalMs);
  }
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  on(listener) {
    this.listeners.add(listener);
    if (!this.timer)
      this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0)
        this.stop();
    };
  }
  _poll() {
    if (this.listeners.size === 0)
      return;
    const since = this.lastMs;
    this.lastMs = Date.now();
    const changedNodes = this.nodesSince.all(since);
    for (const node of changedNodes) {
      const op = this.knownNodeIds.has(node.id) ? "update" : "insert";
      this.knownNodeIds.add(node.id);
      this.emit({ op, table: "nodes", id: node.id, data: node });
    }
    const newEdges = this.edgesSince.all(since);
    for (const edge of newEdges) {
      const compositeId = `${edge.src_id}:${edge.dst_id}:${edge.kind}`;
      if (!this.knownEdgeIds.has(compositeId)) {
        this.knownEdgeIds.add(compositeId);
        this.emit({ op: "insert", table: "edges", id: compositeId, data: edge });
      }
    }
  }
  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {}
    }
  }
}

// ../../mcp/src/visualize/server.ts
var VALID_STATUSES = new Set(["pending", "live", "stale", "superseded", "pruned"]);
var VALID_KINDS = new Set([
  "session",
  "file_chunk",
  "tool_output",
  "summary",
  "note",
  "observation",
  "web_chunk",
  "prompt",
  "thinking",
  "response"
]);

class VisualizeServer {
  db;
  httpServer = null;
  watcher;
  unsubscribe = null;
  clients = new Set;
  ui;
  started = false;
  host;
  port;
  constructor(db, options = {}) {
    this.db = db;
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 7777;
    this.watcher = new DbWatcher(db);
    this.ui = readFileSync(join(import.meta.dir, "ui.html"), "utf8");
  }
  async start() {
    if (this.started)
      return { url: this.url, port: this.port };
    const effectivePort = this.port === 0 ? 0 : await findFreePort(this.port);
    const self = this;
    this.httpServer = Bun.serve({
      hostname: this.host,
      port: effectivePort,
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === "/api/events") {
          if (server.upgrade(req))
            return;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        if (url.pathname === "/" || url.pathname === "") {
          return new Response(self.ui, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
        if (url.pathname === "/api/state") {
          const { nodes, edges } = self.snapshot(url.searchParams);
          return Response.json({ nodes, edges });
        }
        if (url.pathname.startsWith("/api/node/")) {
          const id = url.pathname.slice("/api/node/".length);
          const node = self.db.query("SELECT * FROM nodes WHERE id = ?").get(id);
          return node ? Response.json(node) : new Response("Not found", { status: 404 });
        }
        if (url.pathname === "/health") {
          return Response.json(self.stats());
        }
        return new Response("Not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          self.clients.add(ws);
          const { nodes, edges } = self.snapshot(new URLSearchParams);
          ws.send(JSON.stringify({ op: "snapshot", nodes, edges }));
        },
        message() {},
        close(ws) {
          self.clients.delete(ws);
        }
      }
    });
    this.port = this.httpServer.port;
    this.unsubscribe = this.watcher.on((event) => {
      const msg = JSON.stringify(event);
      for (const ws of this.clients) {
        try {
          ws.send(msg);
        } catch {}
      }
    });
    this.started = true;
    return { url: this.url, port: this.port };
  }
  get url() {
    return `http://${this.host}:${this.port}`;
  }
  stats() {
    const nodeCount = this.db.query("SELECT COUNT(*) as count FROM nodes").get()?.count ?? 0;
    const edgeCount = this.db.query("SELECT COUNT(*) as count FROM edges").get()?.count ?? 0;
    return { status: "ok", nodeCount, edgeCount };
  }
  async stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.httpServer?.stop(true);
    this.httpServer = null;
    this.clients.clear();
    this.started = false;
  }
  snapshot(params) {
    const conditions = [];
    const args = [];
    const rawKinds = (params.get("kind") ?? "").split(",").filter((k) => VALID_KINDS.has(k));
    if (rawKinds.length) {
      conditions.push(`kind IN (${rawKinds.map(() => "?").join(",")})`);
      args.push(...rawKinds);
    }
    const rawStatuses = (params.get("status") ?? "").split(",").filter((s) => VALID_STATUSES.has(s));
    if (rawStatuses.length) {
      conditions.push(`status IN (${rawStatuses.map(() => "?").join(",")})`);
      args.push(...rawStatuses);
    } else {
      conditions.push(`status != 'pruned'`);
    }
    const sessionId = params.get("session_id");
    if (sessionId) {
      conditions.push(`json_extract(metadata, '$.session_id') = ?`);
      args.push(sessionId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const nodes = this.db.query(`SELECT * FROM nodes ${where}`).all(...args);
    const edges = this.db.query("SELECT * FROM edges").all();
    return { nodes, edges };
  }
}
async function findFreePort(start) {
  for (let p = start;p < start + 10; p++) {
    try {
      const s = Bun.serve({ port: p, hostname: "127.0.0.1", fetch: () => new Response("") });
      const assignedPort = s.port;
      s.stop(true);
      return assignedPort;
    } catch {
      continue;
    }
  }
  throw new Error(`No free port found in range ${start}\u2013${start + 9}`);
}

// src/cli.ts
function computeProjectHash(cwd) {
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      cwd,
      stdio: ["pipe", "pipe", "pipe"]
    }).toString().trim();
    const firstCommit = execSync("git rev-list --max-parents=0 HEAD", {
      cwd,
      stdio: ["pipe", "pipe", "pipe"]
    }).toString().trim();
    return createHash("sha256").update(`${gitRoot}:${firstCommit}`).digest("hex").slice(0, 16);
  } catch {
    return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  }
}
function resolveDbPath(cwd) {
  const hash = computeProjectHash(cwd);
  const memtreeHome = process.env.MEMTREE_HOME ?? join2(homedir(), ".memtree");
  const dbPath = join2(memtreeHome, hash, "store.db");
  return existsSync(dbPath) ? dbPath : null;
}
var HELP = `
memtree-viz \u2014 real-time graph visualizer for the memtree context store

USAGE
  memtree-viz server start   [--cwd <dir>] [--port <n>] [--no-open]
  memtree-viz server attach  --db <path>  [--port <n>] [--no-open] [--json]

COMMANDS
  server start    Find the memtree DB for the current project, start the
                  HTTP+WebSocket server, and open the browser.

  server attach   Start the server against an explicit database path.
                  Designed for VS Code extension use: outputs a JSON line
                  to stdout then stays running until killed.

OPTIONS (server start)
  --cwd <dir>     Project root to resolve the DB from (default: cwd)
  --port <n>      Port to bind (default: 7777 or $MEMTREE_VIZ_PORT)
  --no-open       Don't open the browser

OPTIONS (server attach)
  --db <path>     Path to the SQLite database file (required)
  --port <n>      Port to bind (default: 7777 or $MEMTREE_VIZ_PORT)
  --no-open       Don't open the browser
  --json          Write {"url","port","nodeCount","edgeCount"} to stdout
                  then stay running silently (use this from VS Code)
`.trim();
var argv = process.argv.slice(2);
var command = argv[0];
var subcommand = argv[1];
if (!command || command === "--help" || command === "-h") {
  console.log(HELP);
  process.exit(0);
}
if (command !== "server") {
  console.error(`Unknown command: ${command}

${HELP}`);
  process.exit(1);
}
if (subcommand === "start") {
  await runStart(argv.slice(2));
} else if (subcommand === "attach") {
  await runAttach(argv.slice(2));
} else {
  console.error(`Unknown subcommand: server ${subcommand ?? "(none)"}

${HELP}`);
  process.exit(1);
}
async function runStart(args) {
  const { values } = parseArgs({
    args,
    options: {
      cwd: { type: "string" },
      port: { type: "string" },
      open: { type: "boolean", default: true }
    },
    strict: true
  });
  const cwd = values.cwd ?? process.cwd();
  const port = parseInt(process.env.MEMTREE_VIZ_PORT ?? values.port ?? "", 10) || 7777;
  const openBrowser = values.open !== false;
  const dbPath = resolveDbPath(cwd);
  if (!dbPath) {
    const hash = computeProjectHash(cwd);
    console.error(`No memtree database found for this project.`);
    console.error(`Expected: ${join2(process.env.MEMTREE_HOME ?? join2(homedir(), ".memtree"), hash, "store.db")}`);
    console.error(`Make sure the memtree MCP server has been run in this project at least once.`);
    process.exit(1);
  }
  const db = new Database(dbPath, { readonly: true });
  const srv = new VisualizeServer(db, { port });
  const { url, port: boundPort } = await srv.start();
  console.log(`memtree visualizer running at ${url}`);
  console.log(`Watching: ${dbPath}`);
  console.log(`Press Ctrl+C to stop.`);
  if (openBrowser) {
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    const { spawnSync } = await import("child_process");
    spawnSync(opener, [url], { stdio: "ignore" });
  }
  process.on("SIGINT", () => {
    srv.stop().then(() => {
      db.close();
      process.exit(0);
    });
  });
  process.on("SIGTERM", () => {
    srv.stop().then(() => {
      db.close();
      process.exit(0);
    });
  });
}
async function runAttach(args) {
  const { values } = parseArgs({
    args,
    options: {
      db: { type: "string" },
      port: { type: "string" },
      open: { type: "boolean", default: false },
      json: { type: "boolean", default: false }
    },
    strict: true
  });
  if (!values.db) {
    console.error(`server attach requires --db <path>

` + HELP);
    process.exit(1);
  }
  if (!existsSync(values.db)) {
    console.error(`Database not found: ${values.db}`);
    process.exit(1);
  }
  const port = parseInt(process.env.MEMTREE_VIZ_PORT ?? values.port ?? "", 10) || 7777;
  const db = new Database(values.db, { readonly: true });
  const srv = new VisualizeServer(db, { port });
  const { url, port: boundPort } = await srv.start();
  const { nodeCount, edgeCount } = srv.stats();
  if (values.json) {
    process.stdout.write(JSON.stringify({ url, port: boundPort, nodeCount, edgeCount }) + `
`);
  } else {
    console.log(`memtree visualizer running at ${url}`);
    console.log(`Database: ${values.db}`);
    if (values.open !== false) {
      const opener = process.platform === "darwin" ? "open" : "xdg-open";
      const { spawnSync } = await import("child_process");
      spawnSync(opener, [url], { stdio: "ignore" });
    }
    console.log(`Press Ctrl+C to stop.`);
  }
  process.on("SIGINT", () => {
    srv.stop().then(() => {
      db.close();
      process.exit(0);
    });
  });
  process.on("SIGTERM", () => {
    srv.stop().then(() => {
      db.close();
      process.exit(0);
    });
  });
}
