import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { openDb } from '../store/db';
import { memtreeBrowse } from './browse';
import { getNodeBySourceUri } from '../store/nodes';
import type { MemtreeConfig } from '../store/types';

const config = {} as MemtreeConfig;

let db: Database;
const _realFetch = globalThis.fetch;

beforeEach(() => { db = openDb(':memory:'); });
afterEach(() => { db.close(); globalThis.fetch = _realFetch; });

// ── fetch mock ────────────────────────────────────────────────────────────────
function mockFetch(html: string, status = 200) {
  global.fetch = mock(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => html,
  })) as unknown as typeof fetch;
}

const SAMPLE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Test Page</title>
  <meta name="description" content="A test page">
</head>
<body>
  <main>
    <h1>Hello World</h1>
    <h2>Section One</h2>
    <p>Some body text here for testing purposes.</p>
  </main>
</body>
</html>`;

describe('memtreeBrowse', () => {
  it('fetches, extracts, and stores a web_chunk node', async () => {
    mockFetch(SAMPLE_HTML);
    const result = await memtreeBrowse(db, config, { url: 'https://example.com/test' });

    expect(result.title).toBe('Test Page');
    expect(result.description).toBe('A test page');
    expect(result.headings).toContain('Hello World');
    expect(result.headings).toContain('Section One');
    expect(result.content).toContain('body text');
    expect(result.cached).toBe(false);
    expect(result.nodeId).toBeTruthy();
    expect(result.truncated).toBe(false);

    const stored = getNodeBySourceUri(db, 'https://example.com/test');
    expect(stored).not.toBeNull();
    expect(stored!.kind).toBe('web_chunk');
  });

  it('returns cached node on second call within TTL', async () => {
    mockFetch(SAMPLE_HTML);
    const first = await memtreeBrowse(db, config, { url: 'https://example.com/cache' });
    expect(first.cached).toBe(false);

    const second = await memtreeBrowse(db, config, { url: 'https://example.com/cache' });
    expect(second.cached).toBe(true);
    expect(second.nodeId).toBe(first.nodeId);
    // fetch should only have been called once
    expect((global.fetch as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  it('bypasses cache when force=true', async () => {
    mockFetch(SAMPLE_HTML);
    await memtreeBrowse(db, config, { url: 'https://example.com/force' });
    await memtreeBrowse(db, config, { url: 'https://example.com/force', force: true });
    expect((global.fetch as ReturnType<typeof mock>).mock.calls.length).toBe(2);
  });

  it('creates supersedes edge when content changes', async () => {
    mockFetch(SAMPLE_HTML);
    const first = await memtreeBrowse(db, config, { url: 'https://example.com/changed' });

    const updatedHtml = SAMPLE_HTML.replace('body text here', 'completely different content now');
    mockFetch(updatedHtml);
    const second = await memtreeBrowse(db, config, {
      url: 'https://example.com/changed',
      force: true,
    });

    expect(second.nodeId).not.toBe(first.nodeId);
    const edge = db.query<{ kind: string }, [string, string]>(
      'SELECT kind FROM edges WHERE src_id = ? AND dst_id = ?'
    ).get(second.nodeId, first.nodeId);
    expect(edge?.kind).toBe('supersedes');
  });

  it('deduplicates unchanged content on re-fetch', async () => {
    mockFetch(SAMPLE_HTML);
    const first = await memtreeBrowse(db, config, { url: 'https://example.com/dedup' });
    const second = await memtreeBrowse(db, config, { url: 'https://example.com/dedup', force: true });

    expect(second.nodeId).toBe(first.nodeId);
    expect(second.cached).toBe(true);
  });

  it('truncates content exceeding budget_tokens', async () => {
    const bigHtml = `<html><body><main>${'word '.repeat(2000)}</main></body></html>`;
    mockFetch(bigHtml);
    const result = await memtreeBrowse(db, config, { url: 'https://example.com/big', budget_tokens: 100 });
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(400 + 10); // 100 tokens * 4 chars + slack
  });

  it('throws on invalid URL', async () => {
    await expect(memtreeBrowse(db, config, { url: 'not-a-url' })).rejects.toThrow();
  });

  it('throws on non-http scheme', async () => {
    await expect(memtreeBrowse(db, config, { url: 'ftp://example.com' })).rejects.toThrow();
  });

  it('throws on HTTP error response', async () => {
    mockFetch('', 404);
    await expect(memtreeBrowse(db, config, { url: 'https://example.com/notfound' })).rejects.toThrow('404');
  });
});
