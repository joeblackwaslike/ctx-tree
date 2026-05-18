import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { openDb, closeDb } from '../store/db';
import { memtreeRead } from './read';
import { DEFAULT_CONFIG } from '../config';
import type { Database } from 'bun:sqlite';

const TEST_DB = '/tmp/memtree-read-test.db';
const FIXTURE_DIR = '/tmp/memtree-read-fixtures';
let db: Database;
const cfg = DEFAULT_CONFIG;

beforeEach(() => {
  db = openDb(TEST_DB);
  mkdirSync(FIXTURE_DIR, { recursive: true });
});
afterEach(() => {
  closeDb(db);
  for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm'])
    if (existsSync(f)) unlinkSync(f);
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe('memtreeRead', () => {
  test('reads a file and returns content within budget', async () => {
    const filePath = join(FIXTURE_DIR, 'sample.ts');
    writeFileSync(filePath, 'export const foo = 1;\nexport const bar = 2;\n');
    const result = await memtreeRead(db, cfg, { path: filePath, budget_tokens: 200 });
    expect(result.content).toContain('foo');
    expect(result.nodeId).toBeTruthy();
  });

  test('creates file_chunk node in store', async () => {
    const filePath = join(FIXTURE_DIR, 'cached.ts');
    writeFileSync(filePath, 'export function hello() { return "world"; }\n');
    await memtreeRead(db, cfg, { path: filePath, budget_tokens: 500 });
    const nodes = db.query("SELECT * FROM nodes WHERE kind = 'file_chunk'").all();
    expect(nodes.length).toBeGreaterThan(0);
  });

  test('returns cached result when mtime unchanged', async () => {
    const filePath = join(FIXTURE_DIR, 'stable.ts');
    writeFileSync(filePath, 'export const x = 42;\n// padding to meet size threshold\n');
    await memtreeRead(db, cfg, { path: filePath, budget_tokens: 500 });
    const count1 = (db.query("SELECT COUNT(*) as n FROM nodes").get() as { n: number }).n;
    await memtreeRead(db, cfg, { path: filePath, budget_tokens: 500 });
    const count2 = (db.query("SELECT COUNT(*) as n FROM nodes").get() as { n: number }).n;
    expect(count2).toBe(count1);
  });

  test('falls back to window chunking for unknown file type', async () => {
    const filePath = join(FIXTURE_DIR, 'data.xyz');
    writeFileSync(filePath, Array(210).fill('x').join('\n'));
    const result = await memtreeRead(db, cfg, { path: filePath, budget_tokens: 2000 });
    expect(result.content).toBeTruthy();
    const meta = JSON.parse(
      (db.query("SELECT metadata FROM nodes WHERE kind='file_chunk' LIMIT 1").get() as any).metadata
    );
    expect(meta.chunking).toBe('window');
  });

  test('rejects path matching denylist (.env)', async () => {
    const filePath = join(FIXTURE_DIR, '.env');
    writeFileSync(filePath, 'SECRET=abc\n');
    await expect(memtreeRead(db, cfg, { path: filePath, budget_tokens: 200 }))
      .rejects.toThrow('Path rejected by denylist');
  });
});
