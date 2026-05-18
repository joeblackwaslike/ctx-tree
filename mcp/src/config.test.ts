import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { loadConfig, DEFAULT_CONFIG } from './config';

const TMP = '/tmp/memtree-config-test';

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe('loadConfig', () => {
  test('returns defaults when no config files exist', () => {
    const cfg = loadConfig('/nonexistent/path');
    expect(cfg.embeddingModel).toBe('nomic-embed-text');
    expect(cfg.capture.maxBytes).toBe(100000);
  });

  test('per-project key replaces global key wholesale', () => {
    const projectRoot = TMP;
    mkdirSync(join(projectRoot, '.memtree'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.memtree', 'config.json'),
      JSON.stringify({ capture: { maxBytes: 50000, filterMinSize: 100 } })
    );
    const cfg = loadConfig(projectRoot);
    expect(cfg.capture.maxBytes).toBe(50000);
    expect(cfg.capture.filterMinSize).toBe(100);
    expect(cfg.walkers.stalenessIntervalMs).toBe(30000);
  });

  test('per-project capture.bash=false is preserved', () => {
    mkdirSync(join(TMP, '.memtree'), { recursive: true });
    writeFileSync(
      join(TMP, '.memtree', 'config.json'),
      JSON.stringify({ capture: { maxBytes: 100000, filterMinSize: 50, bash: false } })
    );
    const cfg = loadConfig(TMP);
    expect(cfg.capture.bash).toBe(false);
  });
});
