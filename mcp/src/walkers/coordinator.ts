import type { Database } from 'bun:sqlite';
import type { MemtreeConfig } from '../store/types.js';
import type { EmbeddingProvider } from '../store/types.js';
import type { SummarizerProvider } from '../store/types.js';
import { runFilterWalker } from './filter.js';
import { runStalenessWalker } from './staleness.js';
import { runPrunerWalker } from './pruner.js';
import { runEmbeddingWalker } from './embedding.js';
import { runSummarizerWalker } from './summarizer.js';
import { runDedupeWalker } from './dedupe.js';

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

  start(db: Database, config: MemtreeConfig, embedding?: EmbeddingProvider | null, summarizer?: SummarizerProvider | null): void {
    this.startupSweep(db, config);

    this.timers.push(
      setInterval(() => withErrorBoundary('filter', () => runFilterWalker(db, config)), 500),
      setInterval(() => withErrorBoundary('staleness', () => runStalenessWalker(db, config)), config.walkers.stalenessIntervalMs),
      setInterval(() => withErrorBoundary('pruner', () => runPrunerWalker(db, config)), config.walkers.prunerIntervalMs),
    );

    if (embedding) {
      this.timers.push(
        setInterval(
          () => withErrorBoundary('embedding', () => runEmbeddingWalker(db, config, embedding)),
          config.walkers.embeddingIdleMs
        )
      );
    }

    if (summarizer) {
      this.timers.push(
        setInterval(
          () => withErrorBoundary('summarizer', () => runSummarizerWalker(db, config, summarizer)),
          config.walkers.embeddingIdleMs
        )
      );
    }

    if (config.walkers.dedupeIntervalMs > 0) {
      this.timers.push(
        setInterval(
          () => withErrorBoundary('dedupe', () => runDedupeWalker(db, config)),
          config.walkers.dedupeIntervalMs
        )
      );
    }
  }

  stop(): void {
    this.timers.forEach(t => clearInterval(t));
    this.timers = [];
  }
}
