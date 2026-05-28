/**
 * UserPromptSubmit hook — stores every non-empty prompt as a `prompt` node
 * and injects a compact nodeId reference back into Claude's context.
 *
 * Wires: prompt --follows--> previous_response (if one exists this session).
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { ulid } from './lib/ulid.mjs';
import { getOrCreateSession, lastNode, countNodes, insertEdge } from './lib/db.mjs';

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

// ── Session node ──────────────────────────────────────────────────────────────
const sessionNodeId = getOrCreateSession(db, sessionId);

// ── Dedup by content hash ─────────────────────────────────────────────────────
const contentHash = createHash('sha256').update(userPrompt).digest('hex');
const existing = db.query(
  `SELECT id FROM nodes WHERE content_hash=? AND kind='prompt' LIMIT 1`
).get(contentHash);
if (existing) {
  process.stdout.write(JSON.stringify({
    systemMessage: `[memtree] Prompt already stored → node ${existing.id}. Pass to subagents: memtree_compose(["${existing.id}"], budget).`,
  }));
  process.exit(0);
}

// ── Store prompt node ─────────────────────────────────────────────────────────
const nodeId    = ulid();
const now       = Date.now();
const title     = userPrompt.slice(0, 80).replaceAll('\n', ' ');
const turnIndex = countNodes(db, sessionNodeId, 'prompt');

db.run(
  `INSERT OR IGNORE INTO nodes
     (id, parent_id, kind, source_uri, content, content_hash,
      status, mtime, created_at, updated_at, truncated, original_bytes, metadata)
   VALUES (?,?,'prompt',?,?,?,'live',0,?,?,0,?,?)`,
  nodeId, sessionNodeId,
  `prompt://${contentHash.slice(0, 16)}`,
  userPrompt, contentHash,
  now, now,
  Buffer.byteLength(userPrompt, 'utf8'),
  JSON.stringify({ session_id: sessionId, title, cwd, turn_index: turnIndex })
);

// ── Wire follows edge: prompt → previous response ─────────────────────────────
const prevResponse = lastNode(db, sessionNodeId, 'response');
if (prevResponse) insertEdge(db, nodeId, prevResponse.id, 'follows', now);

process.stdout.write(JSON.stringify({
  systemMessage: `[memtree] Prompt stored → node ${nodeId} ("${title.slice(0, 60)}…"). Pass full context to subagents: memtree_compose(["${nodeId}"], budget).`,
}));
process.exit(0);
