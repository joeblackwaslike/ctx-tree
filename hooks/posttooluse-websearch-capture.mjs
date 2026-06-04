/**
 * PostToolUse:WebSearch — extracts URLs from search results and stores each
 * as a compact web_chunk node via ctx_tree_browse.
 *
 * Runs fire-and-forget: emits no systemMessage and does not block the response.
 * The stored nodes surface in future sessions via ctx_tree_search and are
 * available to the Agent enrichment hook's FTS pass.
 *
 * Only processes results that contain recognisable URL fields.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { computeProjectHash } from './lib/project-hash.mjs';

const MAX_URLS = 5; // avoid flooding the store with marginal results

// ── Read stdin ────────────────────────────────────────────────────────────────
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));

const cwd        = String(input.cwd ?? process.cwd());
const toolResult = input.tool_response ?? input.tool_result ?? {};

// ── Extract URLs from result ──────────────────────────────────────────────────
function extractUrls(result) {
  const urls = new Set();
  const text = typeof result === 'string' ? result : JSON.stringify(result);

  // JSON array of {url, link, href} objects (most search tool shapes)
  try {
    const parsed = typeof result === 'string' ? JSON.parse(result) : result;
    const items  = Array.isArray(parsed) ? parsed : (parsed?.results ?? parsed?.items ?? []);
    for (const item of items) {
      const u = item?.url ?? item?.link ?? item?.href;
      if (u && typeof u === 'string' && u.startsWith('http')) urls.add(u);
    }
  } catch { /* not JSON — fall through */ }

  // Regex fallback for plain-text or stringified results
  if (urls.size === 0) {
    for (const m of text.matchAll(/https?:\/\/[^\s"'<>,)]+/g)) {
      urls.add(m[0].replace(/[.,;]+$/, ''));
    }
  }

  return [...urls].slice(0, MAX_URLS);
}

const urls = extractUrls(toolResult);
if (urls.length === 0) process.exit(0);

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

// ── Store URLs that aren't already cached ────────────────────────────────────
for (const url of urls) {
  const existing = db.query('SELECT id FROM nodes WHERE source_uri = ? LIMIT 1').get(url);
  if (existing) continue; // already stored from a prior session

  // Record a lightweight stub — the actual page content is fetched on demand
  // via ctx_tree_browse. We store the URL itself so FTS picks it up.
  const nodeId      = randomUUID();
  const now         = Date.now();
  const contentHash = createHash('sha256').update(url).digest('hex');

  try {
    db.run(`
      INSERT OR IGNORE INTO nodes
        (id, parent_id, kind, source_uri, content, content_hash,
         status, mtime, created_at, updated_at, truncated, original_bytes, metadata)
      VALUES
        ($id, NULL, 'web_chunk', $uri, $content, $hash,
         'pending', $now, $now, $now, 0, 0, $meta)
    `, {
      $id:      nodeId,
      $uri:     url,
      $content: url,
      $hash:    contentHash,
      $now:     now,
      $meta:    JSON.stringify({ url, source: 'web_search' }),
    });
  } catch { /* FK or constraint issue — skip */ }
}

process.exit(0);
