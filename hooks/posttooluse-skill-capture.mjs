/**
 * PostToolUse:Skill — stores loaded skill content as a `note` node keyed by
 * skill name so future invocations can be served from the graph without
 * reloading from disk.
 *
 * URI format: skill://<name>
 * Content: full skill markdown as loaded by the Skill tool.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { computeProjectHash } from './lib/project-hash.mjs';

// ── Read stdin ────────────────────────────────────────────────────────────────
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));

const cwd        = String(input.cwd ?? process.cwd());
const toolInput  = input.tool_input  ?? {};
const toolResult = input.tool_response ?? input.tool_result ?? {};

const skillName    = String(toolInput.skill ?? toolInput.name ?? '').trim();
const skillContent = typeof toolResult === 'string'
  ? toolResult
  : (toolResult?.content ?? JSON.stringify(toolResult));

if (!skillName || !skillContent || skillContent.length < 50) process.exit(0);

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

const sourceUri   = `skill://${skillName}`;
const contentHash = createHash('sha256').update(String(skillContent)).digest('hex');

// If content unchanged, just bump updated_at
const existing = db.query('SELECT id, content_hash FROM nodes WHERE source_uri = ? LIMIT 1').get(sourceUri);
if (existing) {
  if (existing.content_hash === contentHash) {
    db.run('UPDATE nodes SET updated_at = ? WHERE id = ?', Date.now(), existing.id);
  } else {
    db.run("UPDATE nodes SET status = 'stale' WHERE id = ?", existing.id);
    storeSkill();
  }
} else {
  storeSkill();
}

function storeSkill() {
  const nodeId = crypto.randomUUID();
  const now    = Date.now();
  db.run(`
    INSERT OR IGNORE INTO nodes
      (id, parent_id, kind, source_uri, content, content_hash,
       status, mtime, created_at, updated_at, truncated, original_bytes, metadata)
    VALUES
      ($id, NULL, 'note', $uri, $content, $hash,
       'live', $now, $now, $now, 0, $bytes, $meta)
  `, {
    $id:      nodeId,
    $uri:     sourceUri,
    $content: String(skillContent),
    $hash:    contentHash,
    $now:     now,
    $bytes:   Buffer.byteLength(String(skillContent), 'utf8'),
    $meta:    JSON.stringify({ skill: skillName }),
  });
}

process.exit(0);
