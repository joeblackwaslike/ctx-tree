import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { ulid } from 'ulid';
import type Database from 'bun:sqlite';
import { insertNode } from './store/nodes.js';
import { shouldDropPath, redactBashOutput, shouldDropBashCommand } from './redaction/index.js';
import type { IngestPayload, MemtreeConfig } from './store/types.js';

// ── Dedup window (in-memory, hash → last-seen epoch ms) ───────────────────────
const dedupWindow = new Map<string, number>();
const DEDUP_TTL_MS = 60_000;

function dedupKey(payload: IngestPayload): string {
  return createHash('sha256')
    .update(payload.tool + JSON.stringify(payload.input))
    .digest('hex');
}

function isDeduped(key: string): boolean {
  const last = dedupWindow.get(key);
  if (last === undefined) return false;
  return Date.now() - last < DEDUP_TTL_MS;
}

function recordDedup(key: string): void {
  dedupWindow.set(key, Date.now());
  // Opportunistically evict stale entries to prevent unbounded growth
  if (dedupWindow.size > 10_000) {
    const cutoff = Date.now() - DEDUP_TTL_MS;
    for (const [k, ts] of dedupWindow) {
      if (ts < cutoff) dedupWindow.delete(k);
    }
  }
}

// ── Gitignore check cache (path → { result, ts }) ────────────────────────────
const gitignoreCache = new Map<string, { result: boolean; ts: number }>();
const GITIGNORE_CACHE_TTL_MS = 30_000;

function isGitignored(filePath: string, cwd: string): boolean {
  const cacheKey = `${cwd}::${filePath}`;
  const cached = gitignoreCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < GITIGNORE_CACHE_TTL_MS) {
    return cached.result;
  }
  // Evict stale entries if cache is large (Fix 3: prevent memory leak)
  if (gitignoreCache.size > 1000) {
    const now = Date.now();
    for (const [k, v] of gitignoreCache) {
      if (now - v.ts > GITIGNORE_CACHE_TTL_MS) gitignoreCache.delete(k);
    }
  }
  let result = false;
  try {
    execFileSync('git', ['check-ignore', '-q', filePath], { cwd, stdio: 'pipe' });
    result = true;
  } catch {
    result = false;
  }
  gitignoreCache.set(cacheKey, { result, ts: Date.now() });
  return result;
}

// ── Content extraction ────────────────────────────────────────────────────────
function extractContent(payload: IngestPayload): string {
  switch (payload.tool) {
    case 'Read': {
      const content = payload.response['content'];
      return typeof content === 'string' ? content : JSON.stringify(payload.response);
    }
    case 'Grep': {
      return JSON.stringify(payload.response);
    }
    case 'Bash': {
      const stdout = typeof payload.response['stdout'] === 'string' ? payload.response['stdout'] : '';
      const stderr = typeof payload.response['stderr'] === 'string' ? payload.response['stderr'] : '';
      return [stdout, stderr].filter(Boolean).join('\n');
    }
    default:
      return JSON.stringify(payload.response);
  }
}

// ── Source URI derivation ─────────────────────────────────────────────────────
function extractSourceUri(payload: IngestPayload): string {
  switch (payload.tool) {
    case 'Read': {
      const path = payload.input['path'];
      return `file://${typeof path === 'string' ? path : String(path)}`;
    }
    case 'Grep': {
      const pattern = payload.input['pattern'] ?? '';
      const path = payload.input['path'] ?? payload.cwd;
      return `grep://${payload.cwd}/${pattern}#${path}`;
    }
    case 'Bash': {
      const cmd = payload.input['command'] ?? payload.input['cmd'] ?? '';
      const prefix = createHash('sha256').update(String(cmd)).digest('hex').slice(0, 12);
      return `tool:Bash#${prefix}`;
    }
    default:
      return `tool:${payload.tool}`;
  }
}

// ── Ring buffer (bounded ingestion queue) ─────────────────────────────────────
const RING_SIZE = 1_000;
const ring: Array<{ db: Database; config: MemtreeConfig; payload: IngestPayload }> = [];
let ringHead = 0;
let ringCount = 0;
let drainScheduled = false;

function enqueuePayload(db: Database, config: MemtreeConfig, payload: IngestPayload): void {
  if (ringCount >= RING_SIZE) {
    process.stderr.write(
      `[memtree/ingest] ring buffer full (${RING_SIZE}), dropping payload tool=${payload.tool}\n`,
    );
    return;
  }
  ring[ringHead] = { db, config, payload };
  ringHead = (ringHead + 1) % RING_SIZE;
  ringCount++;

  if (!drainScheduled) {
    drainScheduled = true;
    setImmediate(drainRing);
  }
}

function drainRing(): void {
  drainScheduled = false;
  const toProcess = ringCount;
  const tail = (ringHead - toProcess + RING_SIZE * 2) % RING_SIZE;
  for (let i = 0; i < toProcess; i++) {
    const idx = (tail + i) % RING_SIZE;
    const item = ring[idx];
    if (item) {
      processPayloadSync(item.db, item.config, item.payload);
      ring[idx] = undefined as any;
    }
  }
  ringCount = 0;
}

// ── Core processing ───────────────────────────────────────────────────────────
function processPayloadSync(db: Database, config: MemtreeConfig, payload: IngestPayload): void {
  const capture = config.capture;

  // 1. Per-tool opt-out flags
  if (payload.tool === 'Read' && capture.read === false) {
    process.stderr.write(`[memtree/ingest] dropped: read capture disabled\n`);
    return;
  }
  if (payload.tool === 'Grep' && capture.grep === false) {
    process.stderr.write(`[memtree/ingest] dropped: grep capture disabled\n`);
    return;
  }
  if (payload.tool === 'Bash' && capture.bash === false) {
    process.stderr.write(`[memtree/ingest] dropped: bash capture disabled\n`);
    return;
  }

  // 2. Path deny-list check for Read/Grep
  if (payload.tool === 'Read' || payload.tool === 'Grep') {
    const filePath = payload.input['path'];
    if (typeof filePath === 'string' && shouldDropPath(filePath, capture.pathDenylistExtra)) {
      process.stderr.write(`[memtree/ingest] dropped: path on denylist: ${filePath}\n`);
      return;
    }
  }

  // 3. Bash command filter
  if (payload.tool === 'Bash') {
    const cmd = payload.input['command'] ?? payload.input['cmd'];
    if (typeof cmd === 'string' && shouldDropBashCommand(cmd)) {
      process.stderr.write(`[memtree/ingest] dropped: bash command blocked\n`);
      return;
    }
  }

  // 4. Extract content and redact if Bash
  let content = extractContent(payload);
  if (payload.tool === 'Bash') {
    content = redactBashOutput(content);
  }

  // 5. Minimum content size gate
  const minSize = capture.filterMinSize ?? 50;
  if (content.length < minSize) {
    process.stderr.write(`[memtree/ingest] dropped: content too small (${content.length} < ${minSize})\n`);
    return;
  }

  // 6. Dedup window check
  const key = dedupKey(payload);
  if (isDeduped(key)) {
    process.stderr.write(`[memtree/ingest] dropped: duplicate within dedup window\n`);
    return;
  }

  // 7. Gitignore flag for Read/Grep
  let gitignored = false;
  if (payload.tool === 'Read' || payload.tool === 'Grep') {
    const filePath = payload.input['path'];
    if (typeof filePath === 'string') {
      gitignored = isGitignored(filePath, payload.cwd);
    }
  }

  // 8. Determine node kind and source_uri
  const kind = payload.tool === 'Read' ? 'file_chunk' : 'tool_output';
  const sourceUri = extractSourceUri(payload);

  // 9. Build metadata
  const metadata: Record<string, unknown> = {
    tool: payload.tool,
    session_id: payload.session_id,
    cwd: payload.cwd,
    ts: payload.ts,
  };
  if (gitignored) metadata['gitignored'] = true;
  if (payload.tool === 'Read') {
    metadata['path'] = payload.input['path'];
  }

  // 10. Truncation / maxBytes (byte-accurate; capture original size before slicing)
  const maxBytes = capture.maxBytes ?? 100_000;
  const originalBytes = Buffer.byteLength(content, 'utf8');
  let truncated = 0;
  if (originalBytes > maxBytes) {
    let low = 0, high = content.length;
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if (Buffer.byteLength(content.slice(0, mid), 'utf8') <= maxBytes) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    content = content.slice(0, low);
    truncated = 1;
  }

  // 11. Content hash (after truncation so hash matches stored content)
  const contentHash = createHash('sha256').update(content).digest('hex');

  // 12. Insert node (fast path — status='live'), then record dedup only on success
  try {
    insertNode(db, ulid(), {
      parent_id: null,
      kind,
      source_uri: sourceUri,
      content,
      content_hash: contentHash,
      status: 'live',
      mtime: payload.ts,
      truncated,
      original_bytes: originalBytes,
      metadata: JSON.stringify(metadata),
    });
    recordDedup(key);
  } catch (err) {
    process.stderr.write(`[memtree/ingest] insert failed: ${err}\n`);
  }
}

// ── Test helpers (not for production use) ────────────────────────────────────

/** Reset all in-memory state. Only call from tests. */
export function _resetIngestState(): void {
  dedupWindow.clear();
  gitignoreCache.clear();
  // Drain ring buffer
  ring.length = 0;
  ringHead = 0;
  ringCount = 0;
  drainScheduled = false;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Main entry point for ingesting a captured tool payload.
 * Fire-and-forget — never throws, logs drops to stderr.
 */
export function processIngest(db: Database, config: MemtreeConfig, payload: IngestPayload): void {
  try {
    enqueuePayload(db, config, payload);
  } catch (err) {
    process.stderr.write(`[memtree/ingest] unexpected error in processIngest: ${err}\n`);
  }
}

/**
 * Exported for testing — synchronous processing that bypasses the ring buffer.
 */
export function _processIngestSyncForTests(db: Database, config: MemtreeConfig, payload: IngestPayload): void {
  try {
    processPayloadSync(db, config, payload);
  } catch (err) {
    process.stderr.write(`[memtree/ingest] unexpected error in processIngestSync: ${err}\n`);
  }
}
