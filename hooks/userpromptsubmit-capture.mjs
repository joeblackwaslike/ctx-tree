/**
 * UserPromptSubmit hook — stores the user's prompt as a `prompt` node
 * and injects a compact nodeId reference back into Claude's context.
 *
 * Payoff: subagents can be handed the nodeId instead of the full prompt text;
 * prior prompts surface via memtree_search in future sessions; the Agent
 * enrichment hook will find relevant prompts in FTS and include them.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

// ── Read stdin ────────────────────────────────────────────────────────────────
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));

const sessionId  = String(input.session_id ?? '');
const cwd        = String(input.cwd ?? process.cwd());
const userPrompt = String(input.user_prompt ?? '').trim();

if (!userPrompt) process.exit(0);

// ── Locate DB ─────────────────────────────────────────────────────────────────
const projectHash = createHash('sha256').update(cwd).digest('hex').slice(0, 16);
const dbPath      = join(process.env.HOME ?? '/tmp', '.memtree', projectHash, 'store.db');
if (!existsSync(dbPath)) process.exit(0);

let db;
try {
  db = new Database(dbPath);
} catch {
  process.exit(0);
}

// ── Dedup by content hash ─────────────────────────────────────────────────────
const contentHash = createHash('sha256').update(userPrompt).digest('hex');
const existing = db.query('SELECT id FROM nodes WHERE content_hash = $h LIMIT 1').get({ $h: contentHash });
if (existing) {
  // Identical prompt already stored — just surface the existing nodeId
  process.stdout.write(JSON.stringify({
    systemMessage: `[memtree] Prompt already stored → node ${existing.id}. Pass to subagents: memtree_compose(["${existing.id}"], budget).`,
  }));
  process.exit(0);
}

// ── Store as prompt node ──────────────────────────────────────────────────────
const nodeId = randomUUID();
const now    = Date.now();
const title  = userPrompt.slice(0, 80).replace(/\n/g, ' ');

db.run(`
  INSERT OR IGNORE INTO nodes
    (id, parent_id, kind, source_uri, content, content_hash,
     status, mtime, created_at, updated_at, truncated, original_bytes, metadata)
  VALUES
    ($id, $parent, 'prompt', $uri, $content, $hash,
     'live', $now, $now, $now, 0, $bytes, $meta)
`, {
  $id:      nodeId,
  $parent:  `session_${sessionId}`,
  $uri:     `prompt://${contentHash.slice(0, 16)}`,
  $content: userPrompt,
  $hash:    contentHash,
  $now:     now,
  $bytes:   Buffer.byteLength(userPrompt, 'utf8'),
  $meta:    JSON.stringify({ session_id: sessionId, title, cwd }),
});

process.stdout.write(JSON.stringify({
  systemMessage: `[memtree] Prompt stored → node ${nodeId} ("${title.slice(0, 60)}…"). Pass full context to subagents: memtree_compose(["${nodeId}"], budget).`,
}));
process.exit(0);
