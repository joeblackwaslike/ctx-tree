import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync, existsSync } from 'fs';
import { openDb, closeDb } from './db';
import type { Database } from 'bun:sqlite';

const TEST_DB = '/tmp/memtree-test.db';
let db: Database;

beforeEach(() => { db = openDb(TEST_DB); });
afterEach(() => {
  closeDb(db);
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  if (existsSync(TEST_DB + '-wal')) unlinkSync(TEST_DB + '-wal');
  if (existsSync(TEST_DB + '-shm')) unlinkSync(TEST_DB + '-shm');
});

describe('openDb', () => {
  test('creates nodes table with all required columns', () => {
    const cols = db.query("PRAGMA table_info(nodes)").all() as { name: string }[];
    const names = cols.map(c => c.name);
    for (const col of ['id', 'parent_id', 'kind', 'source_uri', 'content',
      'content_hash', 'status', 'mtime', 'created_at', 'updated_at',
      'truncated', 'original_bytes', 'metadata']) {
      expect(names).toContain(col);
    }
  });

  test('creates edges table', () => {
    const cols = db.query("PRAGMA table_info(edges)").all() as { name: string }[];
    expect(cols.map(c => c.name)).toContain('kind');
  });

  test('creates nodes_fts virtual table', () => {
    const result = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='nodes_fts'"
    ).get();
    expect(result).toBeTruthy();
  });

  test('nodes_fts is kept in sync via INSERT trigger', () => {
    db.run(
      `INSERT INTO nodes (id,parent_id,kind,source_uri,content,content_hash,
       status,mtime,created_at,updated_at,truncated,original_bytes,metadata)
       VALUES ('01test',null,'note',null,'hello world','abc','live',0,0,0,0,0,'{}')`
    );
    const hit = db.query("SELECT id FROM nodes_fts WHERE nodes_fts MATCH 'hello'").get();
    expect(hit).toBeTruthy();
  });

  test('WAL mode is active', () => {
    const row = db.query('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(row.journal_mode).toBe('wal');
  });
});
