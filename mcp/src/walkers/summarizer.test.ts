import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync, existsSync } from 'fs';
import { openDb, closeDb } from '../store/db.js';
import { insertNode } from '../store/nodes.js';
import { runSummarizerWalker } from './summarizer.js';
import { wrapDatabase } from '../store/backends/sqlite/index.js';
import { ulid } from 'ulid';
import { DEFAULT_CONFIG } from '../config.js';
import type { Database } from 'bun:sqlite';
import type { StoreBackend } from '../store/index.js';
import type { SummarizerProvider } from '../store/types.js';

const TEST_DB = '/tmp/memtree-summarizer-test.db';
const cfg = DEFAULT_CONFIG;
let store: StoreBackend;

// A content string longer than the threshold (default: max(500, 25*20=500) chars)
const LONG_CONTENT = 'x'.repeat(600);
// A content string shorter than the threshold
const SHORT_CONTENT = 'short';

const mockProvider: SummarizerProvider = {
  model: 'mock-summarizer',
  summarize: async (content: string, _contextHint?: string) => `Summary of: ${content.slice(0, 20)}`,
};

let db: Database;

function insertLiveNode(id: string, content = LONG_CONTENT, source_uri: string | null = 'file:///test/file.ts') {
  insertNode(db, id, {
    parent_id: null, kind: 'note', source_uri,
    content, content_hash: id,
    status: 'live', mtime: 0, truncated: 0, original_bytes: content.length, metadata: '{}',
  });
}

beforeEach(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  db = openDb(TEST_DB);
  store = wrapDatabase(db);
});

afterEach(() => {
  closeDb(db);
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

describe('summarizer walker', () => {
  test('no-ops when provider is null', () => {
    const id = ulid();
    insertLiveNode(id);
    runSummarizerWalker(store, cfg, null);
    const row = db.query<{ summary: string | null }, [string]>(
      'SELECT summary FROM nodes WHERE id = ?'
    ).get(id);
    expect(row!.summary).toBeNull();
  });

  test('fetches live nodes with long content and calls summarize', async () => {
    const id = ulid();
    insertLiveNode(id);
    runSummarizerWalker(store, cfg, mockProvider);
    await new Promise(r => setTimeout(r, 50));
    const row = db.query<{ summary: string | null }, [string]>(
      'SELECT summary FROM nodes WHERE id = ?'
    ).get(id);
    expect(row!.summary).not.toBeNull();
    expect(row!.summary).toMatch(/^Summary of: /);
  });

  test('skips nodes with short content (below threshold)', async () => {
    const id = ulid();
    insertLiveNode(id, SHORT_CONTENT);

    let callCount = 0;
    const countingProvider: SummarizerProvider = {
      model: 'mock-summarizer',
      summarize: async () => { callCount++; return 'summary'; },
    };

    runSummarizerWalker(store, cfg, countingProvider);
    await new Promise(r => setTimeout(r, 50));
    expect(callCount).toBe(0);
  });

  test('skips nodes that already have a summary', async () => {
    const id = ulid();
    insertLiveNode(id);
    // Pre-set a summary
    db.run('UPDATE nodes SET summary = ? WHERE id = ?', 'already summarized', id);

    let callCount = 0;
    const countingProvider: SummarizerProvider = {
      model: 'mock-summarizer',
      summarize: async () => { callCount++; return 'new summary'; },
    };

    runSummarizerWalker(store, cfg, countingProvider);
    await new Promise(r => setTimeout(r, 50));
    expect(callCount).toBe(0);
  });

  test('handles provider error gracefully', async () => {
    const id = ulid();
    insertLiveNode(id);

    const errorProvider: SummarizerProvider = {
      model: 'error-model',
      summarize: async () => { throw new Error('summarizer service unavailable'); },
    };

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: string) => { stderrChunks.push(chunk); return true; };

    try {
      expect(() => runSummarizerWalker(store, cfg, errorProvider)).not.toThrow();
      await new Promise(r => setTimeout(r, 50));
      const logged = stderrChunks.join('');
      expect(logged).toMatch(/memtree summarizer error/);
    } finally {
      (process.stderr as any).write = originalWrite;
    }

    // summary should remain null since summarize failed
    const row = db.query<{ summary: string | null }, [string]>(
      'SELECT summary FROM nodes WHERE id = ?'
    ).get(id);
    expect(row!.summary).toBeNull();
  });
});
