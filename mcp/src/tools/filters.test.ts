import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync, existsSync } from 'fs';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { openDb, closeDb } from '../store/db';
import { insertNode } from '../store/nodes';
import { buildFilterSQL } from './filters';
import { searchKeyword } from './search';
import { getRecent } from './recent';
import { wrapDatabase } from '../store/backends/sqlite/index.js';
import type { Database } from 'bun:sqlite';
import type { StoreBackend } from '../store/index.js';

const TEST_DB = '/tmp/ctx-tree-filters-test.db';
let db: Database;
let store: StoreBackend;

beforeEach(() => { db = openDb(TEST_DB); store = wrapDatabase(db); });
afterEach(() => {
  closeDb(db);
  for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm'])
    if (existsSync(f)) unlinkSync(f);
});

function node(id: string, content: string, metadata: Record<string, unknown> = {}) {
  insertNode(db, id, {
    parent_id: null,
    kind: 'tool_output',
    source_uri: null,
    content,
    content_hash: id,
    status: 'live',
    mtime: 0,
    truncated: 0,
    original_bytes: content.length,
    metadata: JSON.stringify(metadata),
  });
}

// ── Unit tests: buildFilterSQL ───────────────────────────────────────────────

describe('buildFilterSQL — metadata filters', () => {
  test('metadata.tool generates correct json_extract clause', () => {
    const { where, params } = buildFilterSQL({ metadata: { tool: 'Bash' } });
    expect(where).toContain("json_extract(metadata,'$.tool') = ?");
    expect(params).toContain('Bash');
  });

  test('metadata.tool with tableAlias uses aliased metadata column', () => {
    const { where, params } = buildFilterSQL({ metadata: { tool: 'Bash' } }, 'n');
    expect(where).toContain("json_extract(n.metadata,'$.tool') = ?");
    expect(params).toContain('Bash');
  });

  test('metadata.gitignored = true generates clause with value 1', () => {
    const { where, params } = buildFilterSQL({ metadata: { gitignored: true } });
    expect(where).toContain("json_extract(metadata,'$.gitignored') = ?");
    expect(params).toContain(1);
  });

  test('metadata.gitignored = false generates clause with value 0', () => {
    const { where, params } = buildFilterSQL({ metadata: { gitignored: false } });
    expect(where).toContain("json_extract(metadata,'$.gitignored') = ?");
    expect(params).toContain(0);
  });

  test('metadata.session_id generates correct json_extract clause', () => {
    const { where, params } = buildFilterSQL({ metadata: { session_id: 'sess-abc' } });
    expect(where).toContain("json_extract(metadata,'$.session_id') = ?");
    expect(params).toContain('sess-abc');
  });

  test('multiple metadata sub-filters combine correctly', () => {
    const { where, params } = buildFilterSQL({
      metadata: { tool: 'Read', session_id: 'sess-1' },
    });
    expect(where).toContain("json_extract(metadata,'$.tool') = ?");
    expect(where).toContain("json_extract(metadata,'$.session_id') = ?");
    expect(params).toContain('Read');
    expect(params).toContain('sess-1');
  });

  test('unknown metadata key throws McpError InvalidParams', () => {
    expect(() =>
      buildFilterSQL({ metadata: { unknownKey: 'x' } as never })
    ).toThrow(McpError);

    try {
      buildFilterSQL({ metadata: { unknownKey: 'x' } as never });
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(ErrorCode.InvalidParams);
      expect((err as McpError).message).toContain('Unknown metadata filter key: unknownKey');
    }
  });

  test('setting both session_id and metadata.session_id throws McpError', () => {
    expect(() =>
      buildFilterSQL({ session_id: 'A', metadata: { session_id: 'B' } })
    ).toThrow(McpError);
  });

  test('empty metadata object produces no extra clauses', () => {
    const { where, params } = buildFilterSQL({ metadata: {} });
    expect(where).not.toContain('json_extract');
    // only the default status clause should be present
    expect(where).toContain('status IN');
    // params should just be the default ['live']
    expect(params).toEqual(['live']);
  });
});

// ── Integration tests ────────────────────────────────────────────────────────

describe('searchKeyword with metadata filters', () => {
  test('filters by metadata.tool returns only matching nodes', async () => {
    node('bash1', 'bash output content here long', { tool: 'Bash' });
    node('read1', 'read output content here long', { tool: 'Read' });
    node('bash2', 'bash another output content', { tool: 'Bash' });

    const { nodes } = await searchKeyword(store, 'output', 20, { metadata: { tool: 'Bash' } });
    const ids = nodes.map(n => n.id);
    expect(ids).toContain('bash1');
    expect(ids).toContain('bash2');
    expect(ids).not.toContain('read1');
  });

  test('filters by metadata.gitignored = true returns only gitignored nodes', async () => {
    node('gi1', 'gitignored file content here', { gitignored: true });
    node('gi2', 'another gitignored file content', { gitignored: true });
    node('normal1', 'normal tracked file content', { gitignored: false });
    node('normal2', 'another tracked file content here', {});

    const { nodes } = await searchKeyword(store, 'content', 20, { metadata: { gitignored: true } });
    const ids = nodes.map(n => n.id);
    expect(ids).toContain('gi1');
    expect(ids).toContain('gi2');
    expect(ids).not.toContain('normal1');
    expect(ids).not.toContain('normal2');
  });
});

describe('getRecent with metadata filters', () => {
  test('filters by metadata.tool in recent', async () => {
    node('r1', 'recent bash content', { tool: 'Bash' });
    node('r2', 'recent write content', { tool: 'Write' });

    const nodes = await getRecent(store, undefined, 50, { metadata: { tool: 'Bash' } });
    const ids = nodes.map(n => n.id);
    expect(ids).toContain('r1');
    expect(ids).not.toContain('r2');
  });

  test('filters by metadata.gitignored = true in recent', async () => {
    node('gi1', 'gitignored recent content here', { gitignored: true });
    node('gi2', 'another gitignored recent content', { gitignored: true });
    node('normal1', 'normal tracked recent content', {});

    const nodes = await getRecent(store, undefined, 50, { metadata: { gitignored: true } });
    const ids = nodes.map(n => n.id);
    expect(ids).toContain('gi1');
    expect(ids).toContain('gi2');
    expect(ids).not.toContain('normal1');
  });
});
