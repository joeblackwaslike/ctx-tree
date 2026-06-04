/**
 * PreToolUse:Agent — enriches the subagent prompt with:
 *   1. ctx-tree tool map (always)
 *   2. FTS keyword hits from prior session work (when store is populated)
 *
 * Also lazily creates a session node on first Agent call, and writes a
 * state file that posttooluse-agent-capture.mjs picks up to wire derived_from edges.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { computeProjectHash } from './lib/project-hash.mjs';
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
const projectHash = computeProjectHash(cwd);
const dbPath      = join(process.env.HOME ?? '/tmp', '.ctx-tree', projectHash, 'store.db');
const hooksDir    = join(process.env.HOME ?? '/tmp', '.ctx-tree', 'hooks');
mkdirSync(hooksDir, { recursive: true, mode: 0o700 });

// ── Session node ID is deterministic — write state before any early exit ──────
const sessionNodeId = `session_${sessionId}`;
const now           = Date.now();
const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9_\-]/g, '_');
const stateFile     = join(hooksDir, `${safeSessionId}-agent.json`);
writeFileSync(stateFile, JSON.stringify({ sessionNodeId, ts: now, taskPreview: taskText.slice(0, 120) }));

if (!existsSync(dbPath)) {
  // Store not initialised yet — inject tool map only
  emitEnrichedPrompt(toolInput, taskText, sessionNodeId, []);
  process.exit(0);
}

let db;
try {
  db = new Database(dbPath);
} catch (err) {
  process.stderr.write(`[ctx-tree] hook error: ${err}\n`);
  emitEnrichedPrompt(toolInput, taskText, sessionNodeId, []);
  process.exit(0);
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
  } catch (err) {
    process.stderr.write(`[ctx-tree] hook error: ${err}\n`);
    relevantNodes = [];
  }
}

emitEnrichedPrompt(toolInput, taskText, sessionNodeId, relevantNodes);

// ── Helpers ───────────────────────────────────────────────────────────────────
function emitEnrichedPrompt(toolInput, taskText, sessionNodeId, relevantNodes) {
  let ctx = '\n\n[ctx-tree context]\n';

  if (sessionNodeId) ctx += `Session node: ${sessionNodeId}\n`;

  ctx += `ctx-tree MCP tools — use these instead of native tools:\n`;
  ctx += `  ctx_tree_read({path})                   → Read\n`;
  ctx += `  ctx_tree_grep({pattern, path})          → Grep / Bash(rg)\n`;
  ctx += `  ctx_tree_browse({url})                  → WebFetch\n`;
  ctx += `  ctx_tree_monitor({command})             → Bash when output could be large\n`;
  ctx += `  ctx_tree_compose([nodeIds], budget)     → assemble multi-file context\n`;
  ctx += `  ctx_tree_recent()                       → surface prior session captures\n`;
  ctx += `  ctx_tree_search(query)                  → keyword search across all nodes\n`;
  ctx += `  ctx_tree_neighbors(nodeId)              → find related nodes\n`;

  if (relevantNodes.length > 0) {
    ctx += `\nRelevant prior context (${relevantNodes.length} nodes matched your task):\n`;
    for (const n of relevantNodes) {
      ctx += `  [${n.id}] (${n.kind}) ${String(n.preview ?? '').slice(0, 140)}\n`;
    }
    const ids = relevantNodes.map(n => JSON.stringify(n.id)).join(', ');
    ctx += `\nCall ctx_tree_compose([${ids}], 3000) to load this context before starting.\n`;
  }

  ctx += `[/ctx-tree context]`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { ...toolInput, prompt: taskText + ctx },
    },
  }));
  process.exit(0);
}
