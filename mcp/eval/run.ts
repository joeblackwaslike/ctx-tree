import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { openDb, closeDb } from '../src/store/db';
import { DEFAULT_CONFIG } from '../src/config';
import { runSecurityCases } from './cases/security';
import { runLatencyCases } from './cases/latency';
import { memtreeCompose } from '../src/tools/compose';

const DB_PATH = '/tmp/memtree-eval.db';
const FIXTURE_DIR = join(import.meta.dir, 'fixtures', 'src');
const FIXTURE_FILE = join(FIXTURE_DIR, 'math.ts');

async function main() {
  for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm'])
    if (existsSync(f)) unlinkSync(f);

  const db = openDb(DB_PATH);
  const cfg = DEFAULT_CONFIG;
  let failed = 0;

  console.log('\n=== Security Cases ===');
  const secResults = await runSecurityCases(db);
  for (const r of secResults) {
    const icon = r.passed ? '✓' : '✗';
    console.log(`  ${icon} ${r.name}${r.error ? `: ${r.error}` : ''}`);
    if (!r.passed) failed++;
  }

  console.log('\n=== Latency Cases ===');
  const latResults = await runLatencyCases(db, cfg, FIXTURE_FILE);
  for (const r of latResults) {
    const icon = r.passed ? '✓' : '✗';
    console.log(`  ${icon} ${r.name}: p50=${r.p50Ms.toFixed(1)}ms p95=${r.p95Ms.toFixed(1)}ms (threshold: ${r.thresholdMs}ms)`);
    if (!r.passed) failed++;
  }

  console.log('\n=== Schema Rejection ===');
  try {
    await memtreeCompose(db, { node_ids: ['x'], budget_tokens: 100, format: 'mixed' as any });
    console.log('  ✗ compose format=mixed should have thrown');
    failed++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('deferred to v1.1')) {
      console.log('  ✓ compose format=mixed correctly rejected');
    } else {
      console.log(`  ✗ compose format=mixed threw wrong error: ${msg}`);
      failed++;
    }
  }

  closeDb(db);
  for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm'])
    if (existsSync(f)) unlinkSync(f);

  console.log(`\n${failed === 0 ? '✓ All eval cases passed' : `✗ ${failed} case(s) failed`}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
