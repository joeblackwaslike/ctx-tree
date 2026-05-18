import type { Database } from 'bun:sqlite';
import { memtreeRead } from '../../src/tools/read';
import type { MemtreeConfig } from '../../src/store/types';

export interface LatencyResult {
  name: string;
  p50Ms: number;
  p95Ms: number;
  thresholdMs: number;
  passed: boolean;
}

async function measureMs(fn: () => Promise<void>, n: number): Promise<{ p50: number; p95: number }> {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { p50: times[Math.floor((n - 1) * 0.5)], p95: times[Math.floor((n - 1) * 0.95)] };
}

export async function runLatencyCases(
  db: Database,
  config: MemtreeConfig,
  fixturePath: string
): Promise<LatencyResult[]> {
  await memtreeRead(db, config, { path: fixturePath, budget_tokens: 2000 });

  const { p50, p95 } = await measureMs(
    () => memtreeRead(db, config, { path: fixturePath, budget_tokens: 2000 }),
    20
  );

  return [{
    name: 'memtree.read cached p50',
    p50Ms: p50, p95Ms: p95,
    thresholdMs: 50,
    passed: p50 < 50,
  }];
}
