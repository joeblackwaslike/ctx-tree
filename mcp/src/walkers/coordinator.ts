import type { Database } from 'bun:sqlite';
import type { MemtreeConfig } from '../store/types';
import { runFilterWalker } from './filter';
import { runStalenessWalker } from './staleness';
import { runPrunerWalker } from './pruner';

function withErrorBoundary(name: string, fn: () => void): void {
  try { fn(); } catch (e) {
    process.stderr.write(`memtree ${name} error: ${e}\n`);
  }
}

export class WalkerCoordinator {
  private timers: ReturnType<typeof setInterval>[] = [];

  startupSweep(db: Database, config: MemtreeConfig): void {
    let swept = 0;
    while (true) {
      const before = (db.query("SELECT COUNT(*) as n FROM nodes WHERE status='pending'").get() as { n: number }).n;
      if (before === 0) break;
      withErrorBoundary('filter-startup-sweep', () => runFilterWalker(db, config));
      swept++;
      if (swept > 1000) break;
    }
    if (swept > 0) process.stderr.write(`memtree: startup sweep processed pending rows in ${swept} passes\n`);
  }

  start(db: Database, config: MemtreeConfig): void {
    this.startupSweep(db, config);

    this.timers.push(
      setInterval(() => withErrorBoundary('filter', () => runFilterWalker(db, config)), 500),
      setInterval(() => withErrorBoundary('staleness', () => runStalenessWalker(db, config)), config.walkers.stalenessIntervalMs),
      setInterval(() => withErrorBoundary('pruner', () => runPrunerWalker(db, config)), config.walkers.prunerIntervalMs),
    );
  }

  stop(): void {
    this.timers.forEach(t => clearInterval(t));
    this.timers = [];
  }
}
