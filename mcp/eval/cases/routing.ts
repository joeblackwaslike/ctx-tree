import { createHash } from 'crypto';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { MemtreeConfig, IngestPayload, MemtreeNode } from '../../src/store/types';
import { _processIngestSyncForTests, _resetIngestState } from '../../src/ingest';

export interface RoutingResult {
  name: string;
  passed: boolean;
  error?: string;
}

// Enough content to pass the 50-byte filterMinSize gate.
const PAD = (s: string) => (s.length >= 60 ? s : s + ' '.repeat(60 - s.length));

function makePayload(
  tool: string,
  input: Record<string, unknown>,
  response: Record<string, unknown>,
  idSuffix?: string
): IngestPayload {
  return {
    tool,
    input,
    response,
    session_id: `eval-session-${idSuffix ?? ulid()}`,
    cwd: '/tmp',
    ts: Date.now(),
  };
}

function queryNodesBySourceUri(db: Database, sourceUri: string): MemtreeNode[] {
  return db.query('SELECT * FROM nodes WHERE source_uri = ?').all(sourceUri) as MemtreeNode[];
}

function queryNodesByTool(db: Database, tool: string, sessionId: string): MemtreeNode[] {
  return db.query(
    `SELECT * FROM nodes WHERE json_extract(metadata, '$.tool') = ?
     AND json_extract(metadata, '$.session_id') = ?`
  ).all(tool, sessionId) as MemtreeNode[];
}

export async function runRoutingCases(
  db: Database,
  config: MemtreeConfig
): Promise<RoutingResult[]> {
  const results: RoutingResult[] = [];

  // ── Case 1: hook-payload-normalization:Read ───────────────────────────────
  {
    _resetIngestState();
    const sessionId = `eval-read-${ulid()}`;
    const filePath = '/tmp/eval-fixture.ts';
    const content = PAD('export function add(a: number, b: number): number { return a + b; }');
    const payload = makePayload(
      'Read',
      { path: filePath },
      { content },
      sessionId
    );
    payload.session_id = sessionId;

    _processIngestSyncForTests(db, config, payload);

    let passed = false;
    let error: string | undefined;
    try {
      const nodes = queryNodesByTool(db, 'Read', sessionId);
      if (nodes.length === 0) {
        error = 'No nodes inserted for Read payload';
      } else {
        const node = nodes[0];
        const meta = JSON.parse(node.metadata) as Record<string, unknown>;
        const hasKind = node.kind === 'file_chunk';
        const hasUri = typeof node.source_uri === 'string' && node.source_uri.startsWith('file://');
        const hasTool = meta['tool'] === 'Read';
        passed = hasKind && hasUri && hasTool;
        if (!passed) {
          error = `kind=${node.kind} source_uri=${node.source_uri} meta.tool=${meta['tool']}`;
        }
      }
    } catch (e: unknown) {
      error = `Unexpected error: ${(e as Error).message}`;
    }
    results.push({ name: 'hook-payload-normalization:Read', passed, error });
  }

  // ── Case 2: hook-payload-normalization:Grep ───────────────────────────────
  {
    _resetIngestState();
    const sessionId = `eval-grep-${ulid()}`;
    const grepResponse = JSON.stringify([
      { file: '/tmp/foo.ts', line: 12, match: 'authenticate(user, password)' },
      { file: '/tmp/bar.ts', line: 34, match: 'authenticate(token) returns session' },
    ]);
    // Grep response must exceed filterMinSize (50 bytes). JSON stringify above handles it.
    const payload = makePayload(
      'Grep',
      { pattern: 'authenticate', path: '/tmp' },
      { output: grepResponse },
      sessionId
    );
    payload.session_id = sessionId;

    _processIngestSyncForTests(db, config, payload);

    let passed = false;
    let error: string | undefined;
    try {
      const nodes = queryNodesByTool(db, 'Grep', sessionId);
      if (nodes.length === 0) {
        error = 'No nodes inserted for Grep payload';
      } else {
        const node = nodes[0];
        const meta = JSON.parse(node.metadata) as Record<string, unknown>;
        const hasKind = node.kind === 'tool_output';
        const hasTool = meta['tool'] === 'Grep';
        passed = hasKind && hasTool;
        if (!passed) error = `kind=${node.kind} meta.tool=${meta['tool']}`;
      }
    } catch (e: unknown) {
      error = `Unexpected error: ${(e as Error).message}`;
    }
    results.push({ name: 'hook-payload-normalization:Grep', passed, error });
  }

  // ── Case 3: hook-payload-normalization:Bash ───────────────────────────────
  {
    _resetIngestState();
    const sessionId = `eval-bash-${ulid()}`;
    const stdout = PAD('total 128\ndrwxr-xr-x  12 user group  384 May 19 10:00 .\n-rw-r--r--   1 user group 4096 May 19 10:00 index.ts\n');
    const payload = makePayload(
      'Bash',
      { command: 'ls -la /tmp' },
      { stdout, stderr: '' },
      sessionId
    );
    payload.session_id = sessionId;

    _processIngestSyncForTests(db, config, payload);

    let passed = false;
    let error: string | undefined;
    try {
      const nodes = queryNodesByTool(db, 'Bash', sessionId);
      if (nodes.length === 0) {
        error = 'No nodes inserted for Bash payload';
      } else {
        const node = nodes[0];
        const meta = JSON.parse(node.metadata) as Record<string, unknown>;
        const hasKind = node.kind === 'tool_output';
        const hasTool = meta['tool'] === 'Bash';
        passed = hasKind && hasTool;
        if (!passed) error = `kind=${node.kind} meta.tool=${meta['tool']}`;
      }
    } catch (e: unknown) {
      error = `Unexpected error: ${(e as Error).message}`;
    }
    results.push({ name: 'hook-payload-normalization:Bash', passed, error });
  }

  // ── Case 4: path-denylist-drops ───────────────────────────────────────────
  {
    _resetIngestState();
    const sessionId = `eval-path-deny-${ulid()}`;
    const payload = makePayload(
      'Read',
      { path: '/home/user/.env' },
      { content: PAD('SECRET=supersecret\nANTHROPIC_API_KEY=sk-ant-xyz\nDATABASE_URL=postgres://') },
      sessionId
    );
    payload.session_id = sessionId;

    _processIngestSyncForTests(db, config, payload);

    let passed = false;
    let error: string | undefined;
    try {
      const nodes = queryNodesByTool(db, 'Read', sessionId);
      passed = nodes.length === 0;
      if (!passed) error = `Expected 0 nodes but got ${nodes.length} for denylist path`;
    } catch (e: unknown) {
      error = `Unexpected error: ${(e as Error).message}`;
    }
    results.push({ name: 'path-denylist-drops', passed, error });
  }

  // ── Case 5: bash-denylist-drops ───────────────────────────────────────────
  {
    _resetIngestState();
    const sessionId = `eval-bash-deny-${ulid()}`;
    const payload = makePayload(
      'Bash',
      { command: 'env' },
      { stdout: PAD('HOME=/Users/user\nPATH=/usr/bin:/bin\nANTHROPIC_API_KEY=sk-ant-redacted'), stderr: '' },
      sessionId
    );
    payload.session_id = sessionId;

    _processIngestSyncForTests(db, config, payload);

    let passed = false;
    let error: string | undefined;
    try {
      const nodes = queryNodesByTool(db, 'Bash', sessionId);
      passed = nodes.length === 0;
      if (!passed) error = `Expected 0 nodes but got ${nodes.length} for denied bash command`;
    } catch (e: unknown) {
      error = `Unexpected error: ${(e as Error).message}`;
    }
    results.push({ name: 'bash-denylist-drops', passed, error });
  }

  return results;
}
