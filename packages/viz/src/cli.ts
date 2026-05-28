#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { VisualizeServer } from '../../../mcp/src/visualize/server.js';

// ── Project hash (mirrors mcp/src/project-hash.ts) ────────────────────────────

function computeProjectHash(cwd: string): string {
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      cwd, stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
    const firstCommit = execSync('git rev-list --max-parents=0 HEAD', {
      cwd, stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
    return createHash('sha256')
      .update(`${gitRoot}:${firstCommit}`)
      .digest('hex')
      .slice(0, 16);
  } catch {
    return createHash('sha256').update(cwd).digest('hex').slice(0, 16);
  }
}

function resolveDbPath(cwd: string): string | null {
  const hash = computeProjectHash(cwd);
  const memtreeHome = process.env.MEMTREE_HOME ?? join(homedir(), '.memtree');
  const dbPath = join(memtreeHome, hash, 'store.db');
  return existsSync(dbPath) ? dbPath : null;
}

// ── Help ───────────────────────────────────────────────────────────────────────

const HELP = `
memtree-viz — real-time graph visualizer for the memtree context store

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
  --port <n>      Port to bind (default: 7777 or \$MEMTREE_VIZ_PORT)
  --no-open       Don't open the browser

OPTIONS (server attach)
  --db <path>     Path to the SQLite database file (required)
  --port <n>      Port to bind (default: 7777 or \$MEMTREE_VIZ_PORT)
  --no-open       Don't open the browser
  --json          Write {"url","port","nodeCount","edgeCount"} to stdout
                  then stay running silently (use this from VS Code)
`.trim();

// ── Entry point ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const command = argv[0];
const subcommand = argv[1];

if (!command || command === '--help' || command === '-h') {
  console.log(HELP);
  process.exit(0);
}

if (command !== 'server') {
  console.error(`Unknown command: ${command}\n\n${HELP}`);
  process.exit(1);
}

if (subcommand === 'start') {
  await runStart(argv.slice(2));
} else if (subcommand === 'attach') {
  await runAttach(argv.slice(2));
} else {
  console.error(`Unknown subcommand: server ${subcommand ?? '(none)'}\n\n${HELP}`);
  process.exit(1);
}

// ── server start ──────────────────────────────────────────────────────────────

async function runStart(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      cwd:    { type: 'string' },
      port:   { type: 'string' },
      open:   { type: 'boolean', default: true },
    },
    strict: true,
  });

  const cwd = values.cwd ?? process.cwd();
  const port = parseInt(process.env.MEMTREE_VIZ_PORT ?? values.port ?? '', 10) || 7777;
  const openBrowser = values.open !== false;

  const dbPath = resolveDbPath(cwd);
  if (!dbPath) {
    const hash = computeProjectHash(cwd);
    console.error(`No memtree database found for this project.`);
    console.error(`Expected: ${join(process.env.MEMTREE_HOME ?? join(homedir(), '.memtree'), hash, 'store.db')}`);
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
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const { spawnSync } = await import('node:child_process');
    spawnSync(opener, [url], { stdio: 'ignore' });
  }

  // Keep the process alive; the Bun HTTP server holds the event loop open.
  process.on('SIGINT', () => { srv.stop().then(() => { db.close(); process.exit(0); }); });
  process.on('SIGTERM', () => { srv.stop().then(() => { db.close(); process.exit(0); }); });
}

// ── server attach ─────────────────────────────────────────────────────────────

async function runAttach(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      db:   { type: 'string' },
      port: { type: 'string' },
      open: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
    strict: true,
  });

  if (!values.db) {
    console.error('server attach requires --db <path>\n\n' + HELP);
    process.exit(1);
  }

  if (!existsSync(values.db)) {
    console.error(`Database not found: ${values.db}`);
    process.exit(1);
  }

  const port = parseInt(process.env.MEMTREE_VIZ_PORT ?? values.port ?? '', 10) || 7777;

  const db = new Database(values.db, { readonly: true });
  const srv = new VisualizeServer(db, { port });
  const { url, port: boundPort } = await srv.start();
  const { nodeCount, edgeCount } = srv.stats();

  if (values.json) {
    process.stdout.write(JSON.stringify({ url, port: boundPort, nodeCount, edgeCount }) + '\n');
  } else {
    console.log(`memtree visualizer running at ${url}`);
    console.log(`Database: ${values.db}`);
    if (values.open !== false) {
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
      const { spawnSync } = await import('node:child_process');
      spawnSync(opener, [url], { stdio: 'ignore' });
    }
    console.log(`Press Ctrl+C to stop.`);
  }

  process.on('SIGINT', () => { srv.stop().then(() => { db.close(); process.exit(0); }); });
  process.on('SIGTERM', () => { srv.stop().then(() => { db.close(); process.exit(0); }); });
}
