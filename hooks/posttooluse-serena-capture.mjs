/**
 * PostToolUse:mcp__plugin_serena_serena__* — stores Serena tool results in the
 * ctx-tree graph so they surface via ctx_tree_search / ctx_tree_neighbors in
 * future sessions, just like native Read/Grep results.
 *
 * Runs fire-and-forget: emits no systemMessage and does not block the response.
 *
 * Skips write/admin operations (response too small to pass the 50-byte gate),
 * and deduplicates file reads by source_uri so re-reading the same file within
 * a session is a no-op.
 */

import { createHash } from 'node:crypto';
import { ulid } from './lib/ulid.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { computeProjectHash } from './lib/project-hash.mjs';

const MAX_BYTES  = 100_000;
const MIN_BYTES  = 50;

// ── Read stdin ────────────────────────────────────────────────────────────────
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));

const toolName     = String(input.tool_name ?? '');
const toolInput    = input.tool_input  ?? {};
const toolResponse = input.tool_response ?? input.tool_result ?? '';
const cwd          = String(input.cwd ?? process.cwd());

if (!toolName.startsWith('mcp__plugin_serena_serena__')) process.exit(0);

const serenaTool = toolName.slice('mcp__plugin_serena_serena__'.length);

// ── Stringify response ────────────────────────────────────────────────────────
const content = typeof toolResponse === 'string'
  ? toolResponse
  : JSON.stringify(toolResponse);

if (content.length < MIN_BYTES) process.exit(0);

// ── Determine kind + source_uri ───────────────────────────────────────────────
let kind = 'tool_output';
let sourceUri;

switch (serenaTool) {
  case 'read_file': {
    kind = 'file_chunk';
    const rel = String(toolInput.relative_path ?? toolInput.path ?? '');
    const abs = rel.startsWith('/') ? rel : join(cwd, rel);
    sourceUri = `file://${abs}`;
    break;
  }

  case 'get_symbols_overview': {
    // Outline of a file — store as file_chunk so ctx_tree_read dedup logic works
    kind = 'file_chunk';
    const rel = String(toolInput.relative_path ?? toolInput.path ?? '');
    const abs = rel.startsWith('/') ? rel : join(cwd, rel);
    sourceUri = `serena:outline#${abs}`;
    break;
  }

  case 'get_diagnostics_for_file': {
    const rel = String(toolInput.relative_path ?? toolInput.path ?? '');
    const abs = rel.startsWith('/') ? rel : join(cwd, rel);
    sourceUri = `serena:diagnostics#${abs}`;
    break;
  }

  case 'search_for_pattern': {
    const pattern    = String(toolInput.pattern ?? toolInput.regex ?? '');
    const searchPath = String(toolInput.path ?? '.');
    sourceUri = `grep://${cwd}/${pattern}#${searchPath}`;
    break;
  }

  case 'find_file': {
    const pattern = String(toolInput.pattern ?? toolInput.file_name ?? toolInput.name ?? '');
    sourceUri = `serena:find_file#${cwd}/${pattern}`;
    break;
  }

  case 'list_dir': {
    const rel = String(toolInput.relative_path ?? toolInput.path ?? '.');
    const abs = rel.startsWith('/') ? rel : join(cwd, rel);
    sourceUri = `serena:list_dir#${abs}`;
    break;
  }

  default: {
    // find_symbol, find_declaration, find_implementations, find_referencing_symbols, etc.
    const symbolName = String(
      toolInput.symbol_name ?? toolInput.name ?? toolInput.query ??
      Object.values(toolInput)[0] ?? ''
    );
    sourceUri = `serena:${serenaTool}#${symbolName}`;
    break;
  }
}

// ── Open DB ───────────────────────────────────────────────────────────────────
const projectHash = computeProjectHash(cwd);
const dbPath      = join(process.env.HOME ?? '/tmp', '.ctx-tree', projectHash, 'store.db');
if (!existsSync(dbPath)) process.exit(0);

let db;
try {
  db = new Database(dbPath);
} catch {
  process.exit(0);
}

// ── Dedup file reads ──────────────────────────────────────────────────────────
if (kind === 'file_chunk' && sourceUri) {
  const existing = db.query(
    "SELECT id FROM nodes WHERE source_uri = ? AND status = 'live' LIMIT 1"
  ).get(sourceUri);
  if (existing) process.exit(0);
}

// ── Truncate ──────────────────────────────────────────────────────────────────
let finalContent   = content;
let truncated      = 0;
const originalBytes = Buffer.byteLength(content, 'utf8');

if (originalBytes > MAX_BYTES) {
  let low = 0, high = content.length;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (Buffer.byteLength(content.slice(0, mid), 'utf8') <= MAX_BYTES) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  finalContent = content.slice(0, low);
  truncated    = 1;
}

// ── Insert node ───────────────────────────────────────────────────────────────
const now         = Date.now();
const contentHash = createHash('sha256').update(finalContent).digest('hex');
const nodeId      = ulid();
const metadata    = JSON.stringify({
  tool:        toolName,
  serena_tool: serenaTool,
  input:       toolInput,
  cwd,
  ts:          now,
  source:      'serena',
});

try {
  db.run(`
    INSERT OR IGNORE INTO nodes
      (id, parent_id, kind, source_uri, content, content_hash,
       status, mtime, created_at, updated_at, truncated, original_bytes, metadata)
    VALUES
      ($id, NULL, $kind, $uri, $content, $hash,
       'live', $now, $now, $now, $truncated, $originalBytes, $metadata)
  `, {
    $id:            nodeId,
    $kind:          kind,
    $uri:           sourceUri,
    $content:       finalContent,
    $hash:          contentHash,
    $now:           now,
    $truncated:     truncated,
    $originalBytes: originalBytes,
    $metadata:      metadata,
  });
} catch { /* fire-and-forget */ }

process.exit(0);
