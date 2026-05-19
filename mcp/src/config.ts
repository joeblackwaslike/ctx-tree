import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { MemtreeConfig } from './store/types';

export const DEFAULT_CONFIG: MemtreeConfig = {
  embeddingModel: 'nomic-embed-text',
  summarizerModel: 'llama3.2',
  retention: { staleHours: 24, supersededDays: 7 },
  walkers: {
    embeddingIdleMs: 5000,
    embeddingBatchSize: 32,
    summarizerIdleMs: 30000,
    summarizerSubtreeThreshold: 25,
    dedupeIntervalMs: 60000,
    stalenessIntervalMs: 30000,
    prunerIntervalMs: 300000,
  },
  capture: { maxBytes: 100000, filterMinSize: 50 },
  trustedExecution: false,
};

function readJson(path: string): Partial<MemtreeConfig> {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function deepMergeConfig(base: MemtreeConfig, override: Partial<MemtreeConfig>): MemtreeConfig {
  const result = { ...base } as Record<string, unknown>;
  for (const key of Object.keys(override) as (keyof MemtreeConfig)[]) {
    const val = override[key];
    if (val === undefined) continue;
    const baseVal = base[key];
    if (val !== null && typeof val === 'object' && !Array.isArray(val) &&
        baseVal !== null && typeof baseVal === 'object' && !Array.isArray(baseVal)) {
      result[key] = { ...baseVal as object, ...val as object };
    } else {
      result[key] = val;
    }
  }
  return result as MemtreeConfig;
}

export function loadConfig(projectRoot?: string): MemtreeConfig {
  const globalPath = join(process.env.HOME ?? homedir(), '.memtree', 'config.json');
  const globalOverride = existsSync(globalPath) ? readJson(globalPath) : {};

  const projectPath = projectRoot
    ? join(projectRoot, '.memtree', 'config.json')
    : null;
  const projectOverride = projectPath && existsSync(projectPath)
    ? readJson(projectPath)
    : {};

  return deepMergeConfig(deepMergeConfig(DEFAULT_CONFIG, globalOverride), projectOverride);
}
