import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { openDb, closeDb } from '../store/db';
import { memtreeGrep } from './grep';
import { DEFAULT_CONFIG } from '../config';
import type { Database } from 'bun:sqlite';

const TEST_DB = '/tmp/memtree-grep-test.db';
const FIXTURE_DIR = '/tmp/memtree-grep-fixtures';
let db: Database;

beforeEach(() => {
  db = openDb(TEST_DB);
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(join(FIXTURE_DIR, 'a.ts'), 'export function doThing() { return 42; }\n');
  writeFileSync(join(FIXTURE_DIR, 'b.ts'), 'const x = 1; // no match\n');
});
afterEach(() => {
  closeDb(db);
  for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm'])
    if (existsSync(f)) unlinkSync(f);
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe('memtreeGrep', () => {
  test('returns matches for a pattern', async () => {
    const result = await memtreeGrep(db, DEFAULT_CONFIG, {
      pattern: 'doThing',
      path: FIXTURE_DIR,
    });
    expect(result.matches.some(m => m.includes('a.ts'))).toBe(true);
    expect(result.nodeId).toBeTruthy();
  });

  test('creates tool_output node and file_chunk children in store', async () => {
    await memtreeGrep(db, DEFAULT_CONFIG, { pattern: 'doThing', path: FIXTURE_DIR });
    const toolNode = db.query("SELECT * FROM nodes WHERE kind = 'tool_output' LIMIT 1").get();
    expect(toolNode).not.toBeNull();
    const children = db.query("SELECT * FROM nodes WHERE kind = 'file_chunk' AND parent_id = ?").all((toolNode as { id: string }).id);
    expect(children.length).toBeGreaterThan(0);
  });

  test('returns empty matches when pattern not found', async () => {
    const result = await memtreeGrep(db, DEFAULT_CONFIG, {
      pattern: 'nonexistent_xyz_pattern',
      path: FIXTURE_DIR,
    });
    expect(result.matches).toHaveLength(0);
  });

  test('rejects path matching denylist (.env file as search path)', async () => {
    await expect(memtreeGrep(db, DEFAULT_CONFIG, { pattern: 'SECRET', path: '/home/user/.env' }))
      .rejects.toThrow('Path rejected by denylist');
  });
});
