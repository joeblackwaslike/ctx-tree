import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { MemtreeConfig } from './store/types';

export const DEFAULT_CONFIG: MemtreeConfig = {
  embeddingModel: 'nomic-embed-text',
  summarizerModel: 'claude-haiku-4-5',
  retention: { staleHours: 24, supersededDays: 7 },
  walkers: {
    embeddingIdleMs: 5000,
    embeddingBatchSize: 32,
    summarizerSubtreeThreshold: 25,
    dedupeIntervalMs: 60000,
    stalenessIntervalMs: 30000,
    prunerIntervalMs: 300000,
  },
  capture: { maxBytes: 100000, filterMinSize: 10 },
};

function readJson(path: string): Partial<MemtreeConfig> {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

export function loadConfig(projectRoot?: string): MemtreeConfig {
  const globalPath = join(process.env.HOME ?? '~', '.memtree', 'config.json');
  const globalOverride = existsSync(globalPath) ? readJson(globalPath) : {};

  const projectPath = projectRoot
    ? join(projectRoot, '.memtree', 'config.json')
    : null;
  const projectOverride = projectPath && existsSync(projectPath)
    ? readJson(projectPath)
    : {};

  return { ...DEFAULT_CONFIG, ...globalOverride, ...projectOverride };
}
