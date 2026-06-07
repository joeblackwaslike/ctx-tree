import type { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import { ulid } from 'ulid';
import type { CtxTreeConfig } from '../../src/store/types';
import { DEFAULT_CONFIG } from '../../src/config';
import { insertNode } from '../../src/store/nodes';
import { searchKeyword, searchSemantic } from '../../src/tools/search';
import { ctxTreeRead } from '../../src/tools/read';

export interface SearchResult {
  name: string;
  passed: boolean;
  error?: string;
}

// Minimum content length to pass the filterMinSize gate (50 bytes default)
const LONG_CONTENT = (text: string) =>
  text.length >= 50 ? text : text + ' '.repeat(50 - text.length);

function seedNode(
  db: Database,
  id: string,
  content: string,
  kind: 'file_chunk' | 'tool_output' = 'file_chunk'
): void {
  insertNode(db, id, {
    parent_id: null,
    kind,
    source_uri: `file:///tmp/eval-seed-${id}.ts`,
    content,
    content_hash: createHash('sha256').update(content).digest('hex'),
    status: 'live',
    mtime: Date.now(),
    truncated: 0,
    original_bytes: Buffer.byteLength(content, 'utf8'),
    metadata: JSON.stringify({ tool: 'Read', session_id: null, cwd: '/tmp' }),
  });
}

export async function runSearchCases(db: Database): Promise<SearchResult[]> {
  const results: SearchResult[] = [];

  // ── Case 1: semantic-degradation:no-provider ──────────────────────────────
  // Seed nodes with authentication-related content, verify keyword search returns results.
  {
    const prefix = 'srch1-';
    const nodes = [
      [prefix + ulid(), LONG_CONTENT('The authenticate function validates user credentials against the identity provider.')],
      [prefix + ulid(), LONG_CONTENT('Session tokens are issued after successful authentication via the auth module.')],
      [prefix + ulid(), LONG_CONTENT('Authentication flows must handle expired tokens and prompt for re-authentication.')],
      [prefix + ulid(), LONG_CONTENT('The login form collects username and password for authentication purposes.')],
      [prefix + ulid(), LONG_CONTENT('OAuth2 token exchange is used to authenticate users with external providers.')],
    ];
    for (const [id, content] of nodes) seedNode(db, id, content);

    const seededIds = new Set(nodes.map(([id]) => id));
    let passed = false;
    let error: string | undefined;
    try {
      const result = searchKeyword(db, 'authenticate', 10, {});
      const foundSeeded = result.nodes.some(n => seededIds.has(n.id));
      passed = foundSeeded;
      if (!passed) error = `None of the seeded nodes appeared in keyword search results`;
    } catch (e: unknown) {
      error = `Unexpected error: ${(e as Error).message}`;
    }
    results.push({ name: 'semantic-degradation:no-provider', passed, error });
  }

  // ── Case 2: hybrid-keyword-synonym ───────────────────────────────────────
  // Seed synonym nodes ("login") plus one exact-match node ("authenticate").
  // Verify the exact-match node appears in keyword search results.
  {
    const prefix = 'srch2-';
    const exactId = prefix + ulid();
    const synonymNodes: [string, string][] = [
      [prefix + ulid(), LONG_CONTENT('The login form collects username and password for the user session.')],
      [prefix + ulid(), LONG_CONTENT('Login attempts are rate-limited to prevent brute force attacks on accounts.')],
      [prefix + ulid(), LONG_CONTENT('Users must login before accessing protected resources in the application.')],
      [prefix + ulid(), LONG_CONTENT('The login endpoint validates credentials and issues a session cookie to users.')],
    ];
    for (const [id, content] of synonymNodes) seedNode(db, id, content);
    // One node with the exact search term
    seedNode(db, exactId, LONG_CONTENT('Call authenticate() to verify the user identity before granting access.'));

    let passed = false;
    let error: string | undefined;
    try {
      const result = searchKeyword(db, 'authenticate', 10, {});
      const foundExact = result.nodes.some(n => n.id === exactId);
      passed = foundExact;
      if (!passed) {
        const ids = result.nodes.map(n => n.id).join(', ');
        error = `Exact-match node ${exactId} not in results. Got: [${ids}]`;
      }
    } catch (e: unknown) {
      error = `Unexpected error: ${(e as Error).message}`;
    }
    results.push({ name: 'hybrid-keyword-synonym', passed, error });
  }

  // ── Case 3: semantic-mode-no-provider-error ───────────────────────────────
  // Verify searchSemantic throws a clear error when provider is null.
  {
    const cfg: CtxTreeConfig = { ...DEFAULT_CONFIG };
    let passed = false;
    let error: string | undefined;
    try {
      await searchSemantic(db, cfg, null, 'authenticate', 10, {});
      error = 'Expected searchSemantic to throw but it did not';
    } catch (e: unknown) {
      const msg = String((e as Error).message).toLowerCase();
      passed = msg.includes('embedding provider') || msg.includes('semantic search');
      if (!passed) error = `Wrong error message: ${(e as Error).message}`;
    }
    results.push({ name: 'semantic-mode-no-provider-error', passed, error });
  }

  return results;
}

export async function runGracefulDegradationCases(db: Database): Promise<SearchResult[]> {
  const cfg: CtxTreeConfig = { ...DEFAULT_CONFIG };
  const results: SearchResult[] = [];

  // ── Case 1: graceful-degradation:path-denylist ────────────────────────────
  {
    let passed = false;
    let error: string | undefined;
    try {
      await ctxTreeRead(db, cfg, { path: '/home/user/.env', budget_tokens: 200 });
      error = 'Expected ctxTreeRead to throw for denylist path but it did not';
    } catch (e: unknown) {
      passed = String((e as Error).message).includes('Path rejected by denylist');
      if (!passed) error = `Wrong error: ${(e as Error).message}`;
    }
    results.push({ name: 'graceful-degradation:path-denylist', passed, error });
  }

  // ── Case 2: graceful-degradation:semantic-no-provider ────────────────────
  {
    let passed = false;
    let error: string | undefined;
    try {
      await searchSemantic(db, cfg, null, 'login', 10, {});
      error = 'Expected searchSemantic to throw but it did not';
    } catch (e: unknown) {
      const msg = String((e as Error).message).toLowerCase();
      passed = msg.includes('embedding provider') || msg.includes('semantic search');
      if (!passed) error = `Wrong error message: ${(e as Error).message}`;
    }
    results.push({ name: 'graceful-degradation:semantic-no-provider', passed, error });
  }

  return results;
}
