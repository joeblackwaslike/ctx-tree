/**
 * Stop hook — fires at the end of every Claude response turn.
 * Reads the session transcript, extracts the last assistant turn, and stores:
 *   - a `thinking` node  (if thinking blocks are present)
 *   - a `response` node  (text blocks concatenated)
 *
 * Conversation chain wired via `follows` edges:
 *   prompt → thinking → response → (next prompt) → …
 *
 * Causal chain wired via `derived_from` edges:
 *   thinking --derived_from--> prompt
 *   response --derived_from--> thinking  (or prompt when no thinking)
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { ulid } from './lib/ulid.mjs';
import { getOrCreateSession, lastNode, countNodes, insertEdge } from './lib/db.mjs';

// ── Read stdin ────────────────────────────────────────────────────────────────
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));

// Prevent re-entrant stop hooks from triggering infinite loops.
if (input.stop_hook_active) process.exit(0);

const sessionId      = String(input.session_id ?? '');
const cwd            = String(input.cwd ?? process.cwd());
const transcriptPath = String(input.transcript_path ?? '');

if (!transcriptPath || !existsSync(transcriptPath)) process.exit(0);

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

// ── Parse transcript — find last assistant turn ───────────────────────────────
let lastAssistant = null;
try {
  const lines = readFileSync(transcriptPath, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      // Handle both flat {role, content} and wrapped {message: {role, content}} formats.
      const msg = entry.message ?? entry;
      if (msg.role === 'assistant') lastAssistant = msg;
    } catch { /* skip malformed lines */ }
  }
} catch {
  process.exit(0);
}

if (!lastAssistant) process.exit(0);

// ── Extract blocks ────────────────────────────────────────────────────────────
const contentBlocks = Array.isArray(lastAssistant.content)
  ? lastAssistant.content
  : [{ type: 'text', text: String(lastAssistant.content ?? '') }];

const thinkingParts = contentBlocks
  .filter(b => b.type === 'thinking' && b.thinking)
  .map(b => String(b.thinking));

const textParts = contentBlocks
  .filter(b => b.type === 'text' && b.text)
  .map(b => String(b.text));

const thinkingContent = thinkingParts.join('\n\n');
const responseContent = textParts.join('\n\n');

if (!responseContent) process.exit(0);

// ── Session + turn metadata ───────────────────────────────────────────────────
const sessionNodeId = getOrCreateSession(db, sessionId);
const turnIndex     = countNodes(db, sessionNodeId, 'response');
const now           = Date.now();

// ── Dedup response by source_uri (position-based, not content) ───────────────
const responseUri = `response://${sessionId}/${turnIndex}`;
const existingResp = db.query(`SELECT id FROM nodes WHERE source_uri=? LIMIT 1`).get(responseUri);
if (existingResp) process.exit(0);

// ── Predecessor prompt node ───────────────────────────────────────────────────
const prevPrompt = lastNode(db, sessionNodeId, 'prompt');

// ── Store thinking node (if present) ─────────────────────────────────────────
let thinkingNodeId = null;
if (thinkingContent) {
  const thinkingUri  = `thinking://${sessionId}/${turnIndex}`;
  const existing     = db.query(`SELECT id FROM nodes WHERE source_uri=? LIMIT 1`).get(thinkingUri);
  if (!existing) {
    thinkingNodeId     = ulid();
    const thinkingHash = createHash('sha256').update(thinkingContent).digest('hex');
    const redacted     = thinkingParts.every(t => t === '[redacted]');
    const thinkingTitle = thinkingContent.slice(0, 80).replaceAll('\n', ' ');

    db.run(
      `INSERT OR IGNORE INTO nodes
         (id, parent_id, kind, source_uri, content, content_hash,
          status, mtime, created_at, updated_at, truncated, original_bytes, metadata)
       VALUES (?,?,'thinking',?,?,?,'live',0,?,?,0,?,?)`,
      thinkingNodeId, sessionNodeId,
      thinkingUri,
      thinkingContent, thinkingHash,
      now, now,
      Buffer.byteLength(thinkingContent, 'utf8'),
      JSON.stringify({ session_id: sessionId, title: thinkingTitle, cwd, turn_index: turnIndex, redacted })
    );

    // follows: thinking → prompt
    if (prevPrompt) insertEdge(db, thinkingNodeId, prevPrompt.id, 'follows', now);
    // derived_from: thinking → prompt
    if (prevPrompt) insertEdge(db, thinkingNodeId, prevPrompt.id, 'derived_from', now);
  } else {
    thinkingNodeId = existing.id;
  }
}

// ── Store response node ───────────────────────────────────────────────────────
const responseNodeId   = ulid();
const responseHash     = createHash('sha256').update(responseContent).digest('hex');
const responseTitle    = responseContent.slice(0, 80).replaceAll('\n', ' ');
const hasToolUse       = contentBlocks.some(b => b.type === 'tool_use');

db.run(
  `INSERT OR IGNORE INTO nodes
     (id, parent_id, kind, source_uri, content, content_hash,
      status, mtime, created_at, updated_at, truncated, original_bytes, metadata)
   VALUES (?,?,'response',?,?,?,'live',0,?,?,0,?,?)`,
  responseNodeId, sessionNodeId,
  responseUri,
  responseContent, responseHash,
  now, now,
  Buffer.byteLength(responseContent, 'utf8'),
  JSON.stringify({ session_id: sessionId, title: responseTitle, cwd, turn_index: turnIndex, has_tool_use: hasToolUse })
);

// ── Wire edges ────────────────────────────────────────────────────────────────
const followsPredecessor = thinkingNodeId ?? prevPrompt?.id ?? null;
const derivedFrom        = thinkingNodeId ?? prevPrompt?.id ?? null;

if (followsPredecessor) insertEdge(db, responseNodeId, followsPredecessor, 'follows', now);
if (derivedFrom)        insertEdge(db, responseNodeId, derivedFrom, 'derived_from', now);

// No systemMessage — don't inject noise into the next turn's context.
process.exit(0);
