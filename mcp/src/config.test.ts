import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { loadConfig, DEFAULT_CONFIG } from './config';

const TMP = '/tmp/ctx-tree-config-test';

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe('loadConfig', () => {
  test('returns defaults when no config files exist', () => {
    const cfg = loadConfig('/nonexistent/path');
    expect(cfg.embeddingModel).toBe('nomic-embed-text');
    expect(cfg.capture.maxBytes).toBe(100000);
  });

  test('partial nested override preserves sibling defaults', () => {
    const projectRoot = TMP;
    mkdirSync(join(projectRoot, '.ctx-tree'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.ctx-tree', 'config.json'),
      JSON.stringify({ capture: { maxBytes: 50000 } })
    );
    const cfg = loadConfig(projectRoot);
    expect(cfg.capture.maxBytes).toBe(50000);
    // sibling defaults must survive the partial override
    expect(cfg.capture.filterMinSize).toBe(DEFAULT_CONFIG.capture.filterMinSize);
    expect(cfg.walkers.stalenessIntervalMs).toBe(DEFAULT_CONFIG.walkers.stalenessIntervalMs);
  });

  test('per-project capture.bash=false is preserved', () => {
    mkdirSync(join(TMP, '.ctx-tree'), { recursive: true });
    writeFileSync(
      join(TMP, '.ctx-tree', 'config.json'),
      JSON.stringify({ capture: { maxBytes: 100000, filterMinSize: 50, bash: false } })
    );
    const cfg = loadConfig(TMP);
    expect(cfg.capture.bash).toBe(false);
  });
});
