import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { CtxTreeConfig } from './store/types';

export const DEFAULT_CONFIG: CtxTreeConfig = {
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
  backend: { kind: 'sqlite' },
};

function readJson(path: string): Partial<CtxTreeConfig> {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function deepMergeConfig(base: CtxTreeConfig, override: Partial<CtxTreeConfig>): CtxTreeConfig {
  const result = { ...base } as Record<string, unknown>;
  for (const key of Object.keys(override) as (keyof CtxTreeConfig)[]) {
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
  return result as CtxTreeConfig;
}

export function loadConfig(projectRoot?: string): CtxTreeConfig {
  const globalPath = join(process.env.HOME ?? homedir(), '.ctx-tree', 'config.json');
  const globalOverride = existsSync(globalPath) ? readJson(globalPath) : {};

  const projectPath = projectRoot
    ? join(projectRoot, '.ctx-tree', 'config.json')
    : null;
  const projectOverride = projectPath && existsSync(projectPath)
    ? readJson(projectPath)
    : {};

  let merged = deepMergeConfig(deepMergeConfig(DEFAULT_CONFIG, globalOverride), projectOverride);

  // Env var overrides (highest priority)
  if (process.env.CTX_TREE_BACKEND) {
    merged = {
      ...merged,
      backend: { ...merged.backend, kind: process.env.CTX_TREE_BACKEND as import('./store/types.js').BackendKind },
    };
  }
  if (process.env.CTX_TREE_SCHEMA_PATH) {
    merged = {
      ...merged,
      backend: { ...merged.backend, schemaPath: process.env.CTX_TREE_SCHEMA_PATH },
    };
  }

  return merged;
}
