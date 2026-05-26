/**
 * PreToolUse:Agent — enriches the subagent prompt with:
 *   1. memtree tool map (always)
 *   2. FTS keyword hits from prior session work (when store is populated)
 *
 * Also lazily creates a session node on first Agent call, and writes a
 * state file that posttooluse-agent-capture.mjs picks up to wire derived_from edges.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

// ── Read stdin ────────────────────────────────────────────────────────────────
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));

const sessionId = String(input.session_id ?? '');
const cwd       = String(input.cwd ?? process.cwd());
const toolInput = input.tool_input ?? {};

const taskText = String(toolInput.prompt ?? toolInput.description ?? '').trim();
if (!taskText) process.exit(0);

// ── Locate DB ─────────────────────────────────────────────────────────────────
const projectHash = createHash('sha256').update(cwd).digest('hex').slice(0, 16);
const dbPath      = join(process.env.HOME ?? '/tmp', '.memtree', projectHash, 'store.db');
const hooksDir    = join(process.env.HOME ?? '/tmp', '.memtree', 'hooks');
mkdirSync(hooksDir, { recursive: true, mode: 0o700 });

// ── Session node ID is deterministic — write state before any early exit ──────
const sessionNodeId = `session_${sessionId}`;
const now           = Date.now();
const stateFile     = join(hooksDir, `${sessionId}-agent.json`);
writeFileSync(stateFile, JSON.stringify({ sessionNodeId, ts: now, taskPreview: taskText.slice(0, 120) }));

if (!existsSync(dbPath)) {
  // Store not initialised yet — inject tool map only
  emitEnrichedPrompt(toolInput, taskText, sessionNodeId, []);
}

let db;
try {
  db = new Database(dbPath);
} catch {
  emitEnrichedPrompt(toolInput, taskText, sessionNodeId, []);
}

// ── Upsert session node ───────────────────────────────────────────────────────
db.run(`
  INSERT OR IGNORE INTO nodes
    (id, parent_id, kind, source_uri, content, content_hash,
     status, mtime, created_at, updated_at, truncated, original_bytes, metadata)
  VALUES
    ($id, NULL, 'session', $uri, $content, $hash,
     'live', $now, $now, $now, 0, 0, $meta)
`, {
  $id:      sessionNodeId,
  $uri:     `session://${sessionId}`,
  $content: `Session ${sessionId}`,
  $hash:    createHash('sha256').update(sessionId).digest('hex'),
  $now:     now,
  $meta:    JSON.stringify({ session_id: sessionId, cwd, started_at: now }),
});

// ── FTS keyword search ────────────────────────────────────────────────────────
let relevantNodes = [];
const keywords = taskText
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ')
  .split(/\s+/)
  .filter(w => w.length > 3)
  .slice(0, 6);

if (keywords.length > 0) {
  const ftsQuery = keywords.join(' OR ');
  try {
    relevantNodes = db.query(`
      SELECT f.id, n.kind, substr(f.content, 1, 180) AS preview
      FROM   nodes_fts f
      JOIN   nodes n ON f.id = n.id
      WHERE  nodes_fts MATCH $q
      AND    n.status = 'live'
      AND    n.kind != 'session'
      ORDER BY rank
      LIMIT 5
    `).all({ $q: ftsQuery });
  } catch {
    relevantNodes = [];
  }
}

emitEnrichedPrompt(toolInput, taskText, sessionNodeId, relevantNodes);

// ── Helpers ───────────────────────────────────────────────────────────────────
function emitEnrichedPrompt(toolInput, taskText, sessionNodeId, relevantNodes) {
  let ctx = '\n\n[memtree context]\n';

  if (sessionNodeId) ctx += `Session node: ${sessionNodeId}\n`;

  ctx += `memtree MCP tools — use these instead of native tools:\n`;
  ctx += `  memtree_read({path})                   → Read\n`;
  ctx += `  memtree_grep({pattern, path})          → Grep / Bash(rg)\n`;
  ctx += `  memtree_browse({url})                  → WebFetch\n`;
  ctx += `  memtree_monitor({command})             → Bash when output could be large\n`;
  ctx += `  memtree_compose([nodeIds], budget)     → assemble multi-file context\n`;
  ctx += `  memtree_recent()                       → surface prior session captures\n`;
  ctx += `  memtree_search(query)                  → keyword search across all nodes\n`;
  ctx += `  memtree_neighbors(nodeId)              → find related nodes\n`;

  if (relevantNodes.length > 0) {
    ctx += `\nRelevant prior context (${relevantNodes.length} nodes matched your task):\n`;
    for (const n of relevantNodes) {
      ctx += `  [${n.id}] (${n.kind}) ${String(n.preview ?? '').slice(0, 140)}\n`;
    }
    const ids = relevantNodes.map(n => JSON.stringify(n.id)).join(', ');
    ctx += `\nCall memtree_compose([${ids}], 3000) to load this context before starting.\n`;
  }

  ctx += `[/memtree context]`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { ...toolInput, prompt: taskText + ctx },
    },
  }));
  process.exit(0);
}
