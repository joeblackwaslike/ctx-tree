import type { StoreBackend } from '../store/index.js';
import type { MemtreeConfig } from '../store/types.js';
import type { EmbeddingProvider } from '../store/types.js';
import type { SummarizerProvider } from '../store/types.js';
import { runFilterWalker } from './filter.js';
import { runStalenessWalker } from './staleness.js';
import { runPrunerWalker } from './pruner.js';
import { runEmbeddingWalker } from './embedding.js';
import { runSummarizerWalker } from './summarizer.js';
import { runDedupeWalker } from './dedupe.js';

function withErrorBoundary(name: string, fn: () => void | Promise<void>): void {
  try {
    const result = fn();
    if (result instanceof Promise) {
      result.catch(e => {
        process.stderr.write(`memtree ${name} error: ${e}\n`);
      });
    }
  } catch (e) {
    process.stderr.write(`memtree ${name} error: ${e}\n`);
  }
}

export class WalkerCoordinator {
  private timers: ReturnType<typeof setInterval>[] = [];

  async startupSweep(store: StoreBackend, config: MemtreeConfig): Promise<void> {
    let swept = 0;
    while (true) {
      const before = await store.countPendingNodes();
      if (before === 0) break;
      await runFilterWalker(store, config);
      swept++;
      if (swept > 1000) break;
    }
    if (swept > 0) process.stderr.write(`memtree: startup sweep processed pending rows in ${swept} passes\n`);
  }

  start(store: StoreBackend, config: MemtreeConfig, embedding?: EmbeddingProvider | null, summarizer?: SummarizerProvider | null): void {
    this.startupSweep(store, config).catch(e => {
      process.stderr.write(`memtree startup-sweep error: ${e}\n`);
    });

    this.timers.push(
      setInterval(() => withErrorBoundary('filter', () => runFilterWalker(store, config)), 500),
      setInterval(() => withErrorBoundary('staleness', () => runStalenessWalker(store, config)), config.walkers.stalenessIntervalMs),
      setInterval(() => withErrorBoundary('pruner', () => runPrunerWalker(store, config)), config.walkers.prunerIntervalMs),
    );

    if (embedding) {
      this.timers.push(
        setInterval(
          () => withErrorBoundary('embedding', () => runEmbeddingWalker(store, config, embedding)),
          config.walkers.embeddingIdleMs
        )
      );
    }

    if (summarizer) {
      this.timers.push(
        setInterval(
          () => withErrorBoundary('summarizer', () => runSummarizerWalker(store, config, summarizer)),
          config.walkers.summarizerIdleMs
        )
      );
    }

    if (config.walkers.dedupeIntervalMs > 0) {
      this.timers.push(
        setInterval(
          () => withErrorBoundary('dedupe', () => runDedupeWalker(store, config)),
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
