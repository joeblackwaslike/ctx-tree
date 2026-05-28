/**
 * PreToolUse:Skill — short-circuits repeated skill loads by checking the
 * memtree store first.
 *
 * If the skill was loaded in a prior invocation (same or different session),
 * denies the Skill tool and injects a compact reference so the agent can
 * call memtree_compose([nodeId], budget) instead of reloading from disk.
 *
 * First load still goes through normally; the PostToolUse hook stores it.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { computeProjectHash } from './lib/project-hash.mjs';

// ── Read stdin ────────────────────────────────────────────────────────────────
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));

const cwd       = String(input.cwd ?? process.cwd());
const toolInput = input.tool_input ?? {};
const skillName = String(toolInput.skill ?? toolInput.name ?? '').trim();

if (!skillName) process.exit(0);

// ── Open DB ───────────────────────────────────────────────────────────────────
const projectHash = computeProjectHash(cwd);
const dbPath      = join(process.env.HOME ?? '/tmp', '.memtree', projectHash, 'store.db');
if (!existsSync(dbPath)) process.exit(0);

let db;
try {
  db = new Database(dbPath, { readonly: true });
} catch {
  process.exit(0);
}

const sourceUri = `skill://${skillName}`;
const stored = db.query(
  "SELECT id FROM nodes WHERE source_uri = $uri AND status = 'live' LIMIT 1"
).get({ $uri: sourceUri });

if (!stored) process.exit(0); // not cached yet — let first load through

// Skill is cached — deny and hand back a compact reference
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: `Skill "${skillName}" already in memtree store.`,
    additionalContext:
      `Skill "${skillName}" was previously loaded and is stored as node ${stored.id}.\n` +
      `Call memtree_compose(["${stored.id}"], 4000) to retrieve its full content instead of reloading it.\n` +
      `This saves context — the skill content is identical to the last loaded version.`,
  },
}));
process.exit(0);
