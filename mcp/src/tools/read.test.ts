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
    const r1 = await memtreeRead(db, cfg, { path: filePath, budget_tokens: 500 });
    const count1 = (db.query("SELECT COUNT(*) as n FROM nodes").get() as { n: number }).n;
    const r2 = await memtreeRead(db, cfg, { path: filePath, budget_tokens: 500 });
    const count2 = (db.query("SELECT COUNT(*) as n FROM nodes").get() as { n: number }).n;
    expect(count2).toBe(count1);
    expect(r2.nodeId).toBe(r1.nodeId);
    expect(r2.content).toBe(r1.content);
  });

  test('filters chunks to requested line range (0-based)', async () => {
    const filePath = join(FIXTURE_DIR, 'ranged.ts');
    // Write a file with two distinct blocks across lines 0-2 and 4-6 (0-based)
    writeFileSync(filePath, [
      'const BLOCK_A = 1;',  // line 0
      'const A2 = 2;',       // line 1
      'const A3 = 3;',       // line 2
      '',                    // line 3
      'const BLOCK_B = 10;', // line 4
      'const B2 = 20;',      // line 5
      'const B3 = 30;',      // line 6
    ].join('\n'));
    const result = await memtreeRead(db, cfg, { path: filePath, lines: [4, 6], budget_tokens: 2000 });
    expect(result.content).toContain('BLOCK_B');
    expect(result.content).not.toContain('BLOCK_A');
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

  test('uses treesitter chunking for .ts files when parsers are installed', async () => {
    const filePath = join(FIXTURE_DIR, 'functions.ts');
    writeFileSync(filePath, `
export function greet(name: string): string {
  return \`Hello, \${name}\`;
}

export function farewell(name: string): string {
  return \`Goodbye, \${name}\`;
}

export class Greeter {
  greet(name: string) {
    return greet(name);
  }
}
`);
    const result = await memtreeRead(db, cfg, { path: filePath, budget_tokens: 2000 });
    expect(result.content).toBeTruthy();
    // Verify that the chunking strategy is 'treesitter', not 'window'
    expect(result.chunking).toBe('treesitter');
  });
});
