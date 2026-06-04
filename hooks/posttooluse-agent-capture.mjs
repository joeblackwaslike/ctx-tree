/**
 * PostToolUse:Agent — wires subagent work into the CtxTree graph.
 *
 * Reads state written by pretooluse-agent-enrich.mjs, finds all nodes
 * created during the subagent run (by timestamp window), creates a summary
 * `note` node as a child of the session node, and emits `summarizes` edges
 * from the summary to each captured node.
 *
 * After this, ctx_tree_neighbors(sessionNodeId) surfaces both the agent task
 * summary and everything the subagent captured, without the subagent ever
 * having to manage graph links explicitly.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { computeProjectHash } from './lib/project-hash.mjs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

// ── Read stdin ────────────────────────────────────────────────────────────────
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));

const sessionId = String(input.session_id ?? '');
const cwd       = String(input.cwd ?? process.cwd());

// ── Load + consume state file ─────────────────────────────────────────────────
const hooksDir  = join(process.env.HOME ?? '/tmp', '.ctx-tree', 'hooks');
const stateFile = join(hooksDir, `${sessionId}-agent.json`);
if (!existsSync(stateFile)) process.exit(0);

let state;
try {
  state = JSON.parse(readFileSync(stateFile, 'utf8'));
  unlinkSync(stateFile);
} catch (err) {
  process.stderr.write(`[ctx-tree] failed to read state file: ${err}\n`);
  process.exit(0);
}

const { sessionNodeId, ts, taskPreview } = state;

// ── Open DB ───────────────────────────────────────────────────────────────────
const projectHash = computeProjectHash(cwd);
const dbPath      = join(process.env.HOME ?? '/tmp', '.ctx-tree', projectHash, 'store.db');
if (!existsSync(dbPath)) process.exit(0);

let db;
try {
  db = new Database(dbPath);
} catch (err) {
  process.stderr.write(`[ctx-tree] hook error: ${err}\n`);
  process.exit(0);
}

// ── Find nodes captured during the subagent run ───────────────────────────────
const captured = db.query(`
  SELECT id, kind FROM nodes
  WHERE  created_at >= $ts
  AND    kind != 'session'
  ORDER  BY created_at
`).all({ $ts: ts });

if (captured.length === 0) process.exit(0);

// ── Create summary note as child of session node ──────────────────────────────
const summaryId      = randomUUID();
const now            = Date.now();
const summaryContent = `Agent task: ${taskPreview}\nCaptured ${captured.length} node(s): ${captured.map(n => n.id).join(', ')}`;
const summaryHash    = createHash('sha256').update(summaryContent).digest('hex');

db.run(`
  INSERT OR IGNORE INTO nodes
    (id, parent_id, kind, source_uri, content, content_hash,
     status, mtime, created_at, updated_at, truncated, original_bytes, metadata)
  VALUES
    ($id, $parent, 'note', $uri, $content, $hash,
     'live', $now, $now, $now, 0, 0, $meta)
`, {
  $id:      summaryId,
  $parent:  sessionNodeId,
  $uri:     `agent-run://${sessionId}/${ts}`,
  $content: summaryContent,
  $hash:    summaryHash,
  $now:     now,
  $meta:    JSON.stringify({ session_id: sessionId, task: taskPreview, captured_count: captured.length }),
});

// ── Wire summarizes edges ─────────────────────────────────────────────────────
const insertEdge = db.prepare(`
  INSERT OR IGNORE INTO edges (src_id, dst_id, kind, created_at)
  VALUES ($src, $dst, 'summarizes', $now)
`);

for (const node of captured) {
  try {
    insertEdge.run({ $src: summaryId, $dst: node.id, $now: now });
  } catch (err) {
    // FK violation if node was pruned between capture and now — skip
    process.stderr.write(`[ctx-tree] hook error: ${err}\n`);
  }
}

process.exit(0);
