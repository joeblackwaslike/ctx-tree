import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { unlinkSync, existsSync } from 'fs';
import * as childProcess from 'child_process';
import { openDb, closeDb } from './store/db';
import { processIngestSync, _resetIngestState } from './ingest';
import type { IngestPayload, MemtreeConfig } from './store/types';
import type { Database } from 'bun:sqlite';

const TEST_DB = '/tmp/memtree-ingest-test.db';
let db: Database;

const BASE_CONFIG: MemtreeConfig = {
  embeddingModel: 'nomic-embed-text',
  summarizerModel: 'llama3.2',
  retention: { staleHours: 24, supersededDays: 7 },
  walkers: {
    embeddingIdleMs: 5000,
    embeddingBatchSize: 32,
    summarizerSubtreeThreshold: 25,
    dedupeIntervalMs: 60000,
    stalenessIntervalMs: 30000,
    prunerIntervalMs: 300000,
  },
  capture: { maxBytes: 100_000, filterMinSize: 50 },
};

function makeReadPayload(overrides: Partial<IngestPayload> = {}): IngestPayload {
  return {
    tool: 'Read',
    input: { path: '/project/src/main.ts' },
    response: { content: 'x'.repeat(200) },
    session_id: null,
    cwd: '/project',
    ts: Date.now(),
    ...overrides,
  };
}

function makeBashPayload(overrides: Partial<IngestPayload> = {}): IngestPayload {
  return {
    tool: 'Bash',
    input: { command: 'ls -la /project/src' },
    response: { stdout: 'total 42\ndrwxr-xr-x  8 joe staff  256 Jan 1 12:00 .\n' + 'x'.repeat(200) },
    session_id: null,
    cwd: '/project',
    ts: Date.now(),
    ...overrides,
  };
}

function makeGrepPayload(overrides: Partial<IngestPayload> = {}): IngestPayload {
  return {
    tool: 'Grep',
    input: { pattern: 'processIngest', path: '/project/src' },
    response: { matches: ['mcp/src/ingest.ts:42:  export function processIngest'] },
    session_id: null,
    cwd: '/project',
    ts: Date.now(),
    ...overrides,
  };
}

function countNodes(db: Database): number {
  const row = db.query<{ n: number }, []>('SELECT COUNT(*) as n FROM nodes').get();
  return row?.n ?? 0;
}

function getNodeByKind(db: Database, kind: string): { id: string; kind: string; metadata: string } | null {
  return db
    .query<{ id: string; kind: string; metadata: string }, [string]>(
      'SELECT id, kind, metadata FROM nodes WHERE kind = ? LIMIT 1',
    )
    .get(kind);
}

beforeEach(() => {
  db = openDb(TEST_DB);
  _resetIngestState();
});

afterEach(() => {
  closeDb(db);
  for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
    if (existsSync(f)) unlinkSync(f);
  }
});

// ── Per-tool opt-out flags ─────────────────────────────────────────────────────

describe('per-tool capture flags', () => {
  test('drops Read payload when config.capture.read = false', () => {
    const config = { ...BASE_CONFIG, capture: { ...BASE_CONFIG.capture, read: false } };
    processIngestSync(db, config, makeReadPayload());
    expect(countNodes(db)).toBe(0);
  });

  test('drops Grep payload when config.capture.grep = false', () => {
    const config = { ...BASE_CONFIG, capture: { ...BASE_CONFIG.capture, grep: false } };
    processIngestSync(db, config, makeGrepPayload());
    expect(countNodes(db)).toBe(0);
  });

  test('drops Bash payload when config.capture.bash = false', () => {
    const config = { ...BASE_CONFIG, capture: { ...BASE_CONFIG.capture, bash: false } };
    processIngestSync(db, config, makeBashPayload());
    expect(countNodes(db)).toBe(0);
  });
});

// ── Minimum content size gate ──────────────────────────────────────────────────

describe('filterMinSize', () => {
  test('drops payload below filterMinSize', () => {
    const config = { ...BASE_CONFIG, capture: { ...BASE_CONFIG.capture, filterMinSize: 200 } };
    // 'x'.repeat(10) → 10 bytes < 200
    processIngestSync(
      db,
      config,
      makeReadPayload({ response: { content: 'x'.repeat(10) } }),
    );
    expect(countNodes(db)).toBe(0);
  });

  test('accepts payload at or above filterMinSize', () => {
    const config = { ...BASE_CONFIG, capture: { ...BASE_CONFIG.capture, filterMinSize: 50 } };
    processIngestSync(
      db,
      config,
      makeReadPayload({ response: { content: 'x'.repeat(50) } }),
    );
    expect(countNodes(db)).toBe(1);
  });
});

// ── Dedup window ───────────────────────────────────────────────────────────────

describe('dedup window', () => {
  test('drops duplicate payload within 60s dedup window', () => {
    const payload = makeReadPayload();
    processIngestSync(db, BASE_CONFIG, payload);
    // same tool+input → same dedup key
    processIngestSync(db, BASE_CONFIG, { ...payload, ts: payload.ts + 1000 });
    expect(countNodes(db)).toBe(1);
  });
});

// ── Path denylist ──────────────────────────────────────────────────────────────

describe('path denylist', () => {
  test('drops Read payload for denylisted path (.env)', () => {
    processIngestSync(
      db,
      BASE_CONFIG,
      makeReadPayload({ input: { path: '/project/.env' }, response: { content: 'x'.repeat(200) } }),
    );
    expect(countNodes(db)).toBe(0);
  });

  test('drops Read payload for SSH key path', () => {
    processIngestSync(
      db,
      BASE_CONFIG,
      makeReadPayload({
        input: { path: '/home/joe/.ssh/id_rsa' },
        response: { content: 'x'.repeat(200) },
      }),
    );
    expect(countNodes(db)).toBe(0);
  });
});

// ── Valid Read payload → file_chunk node ──────────────────────────────────────

describe('Read ingestion', () => {
  test('inserts file_chunk node for valid Read payload', () => {
    // Use a unique path/content combo to avoid dedup from earlier tests
    processIngestSync(
      db,
      BASE_CONFIG,
      makeReadPayload({
        input: { path: '/project/src/unique-read-test.ts' },
        response: { content: 'unique-read-test-content-' + 'x'.repeat(200) },
      }),
    );
    const node = getNodeByKind(db, 'file_chunk');
    expect(node).not.toBeNull();
    expect(node!.kind).toBe('file_chunk');
  });

  test('source_uri starts with file:// for Read payload', () => {
    const filePath = '/project/src/source-uri-check.ts';
    processIngestSync(
      db,
      BASE_CONFIG,
      makeReadPayload({
        input: { path: filePath },
        response: { content: 'source-uri-check-' + 'x'.repeat(200) },
      }),
    );
    const row = db
      .query<{ source_uri: string }, [string]>(
        'SELECT source_uri FROM nodes WHERE kind = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get('file_chunk');
    expect(row?.source_uri).toBe(`file://${filePath}`);
  });
});

// ── Valid Bash payload → tool_output node ─────────────────────────────────────

describe('Bash ingestion', () => {
  test('inserts tool_output node for valid Bash payload', () => {
    processIngestSync(db, BASE_CONFIG, makeBashPayload());
    const node = getNodeByKind(db, 'tool_output');
    expect(node).not.toBeNull();
    expect(node!.kind).toBe('tool_output');
  });
});

// ── Gitignored metadata flag ───────────────────────────────────────────────────

describe('gitignore flag', () => {
  test('sets metadata.gitignored=true for gitignored path', () => {
    // Mock execSync to simulate git check-ignore returning exit code 0 (file is gitignored)
    const spy = spyOn(childProcess, 'execSync').mockImplementation(
      (cmd: string, _opts?: object) => {
        if (typeof cmd === 'string' && cmd.includes('git check-ignore')) {
          return Buffer.from('');
        }
        // Fallback for any other execSync usage
        return Buffer.from('');
      },
    );

    const filePath = '/project/dist/bundle.js';
    processIngestSync(
      db,
      BASE_CONFIG,
      makeReadPayload({
        input: { path: filePath },
        response: { content: 'gitignored-file-test-' + 'x'.repeat(200) },
      }),
    );

    const row = db
      .query<{ metadata: string }, []>('SELECT metadata FROM nodes ORDER BY created_at DESC LIMIT 1')
      .get();
    expect(row).not.toBeNull();
    const meta = JSON.parse(row!.metadata);
    expect(meta.gitignored).toBe(true);

    spy.mockRestore();
  });

  test('does not set metadata.gitignored for non-gitignored path', () => {
    // Mock execSync to simulate git check-ignore throwing (exit code 1 = not ignored)
    const spy = spyOn(childProcess, 'execSync').mockImplementation(
      (cmd: string, _opts?: object) => {
        if (typeof cmd === 'string' && cmd.includes('git check-ignore')) {
          throw new Error('not ignored');
        }
        return Buffer.from('');
      },
    );

    const filePath = '/project/src/not-ignored.ts';
    processIngestSync(
      db,
      BASE_CONFIG,
      makeReadPayload({
        input: { path: filePath },
        response: { content: 'not-gitignored-test-' + 'x'.repeat(200) },
      }),
    );

    const row = db
      .query<{ metadata: string }, []>('SELECT metadata FROM nodes ORDER BY created_at DESC LIMIT 1')
      .get();
    expect(row).not.toBeNull();
    const meta = JSON.parse(row!.metadata);
    expect(meta.gitignored).toBeUndefined();

    spy.mockRestore();
  });
});

// ── Bash output redaction ──────────────────────────────────────────────────────

describe('Bash output redaction', () => {
  test('redacts API keys in Bash output before storing', () => {
    const secretKey = 'ANTHROPIC_API_KEY=sk-ant-api03-supersecretkeyvalue1234567890';
    processIngestSync(
      db,
      BASE_CONFIG,
      makeBashPayload({
        // Use unique command to avoid dedup collision with other tests
        input: { command: 'cat /tmp/my-secrets' },
        response: {
          stdout: `${secretKey}\nsome other output ${'x'.repeat(100)}`,
        },
      }),
    );

    const row = db
      .query<{ content: string }, []>(
        'SELECT content FROM nodes ORDER BY created_at DESC LIMIT 1',
      )
      .get();
    expect(row).not.toBeNull();
    expect(row!.content).not.toContain('sk-ant-api03-supersecretkeyvalue1234567890');
    expect(row!.content).toContain('[REDACTED:ANTHROPIC_API_KEY]');
  });

  test('drops Bash payload with blocked command (env)', () => {
    processIngestSync(
      db,
      BASE_CONFIG,
      makeBashPayload({ input: { command: 'env' } }),
    );
    expect(countNodes(db)).toBe(0);
  });

  test('drops Bash payload with blocked command (printenv)', () => {
    processIngestSync(
      db,
      BASE_CONFIG,
      makeBashPayload({ input: { command: 'printenv HOME' } }),
    );
    expect(countNodes(db)).toBe(0);
  });
});
