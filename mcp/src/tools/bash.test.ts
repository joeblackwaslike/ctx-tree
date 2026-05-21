import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { openDb, closeDb } from '../store/db.js';
import { memtreeBash } from './bash.js';
import { DEFAULT_CONFIG } from '../config.js';
import { redactBashOutput } from '../redaction/index.js';
import type { Database } from 'bun:sqlite';

let tmpDir: string;
let dbPath: string;
let db: Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'memtree-bash-test-'));
  dbPath = join(tmpDir, 'test.db');
  db = openDb(dbPath);
});

afterEach(() => {
  closeDb(db);
  rmSync(tmpDir, { recursive: true, force: true });
});

const trustedConfig = {
  ...DEFAULT_CONFIG,
  trustedExecution: true,
  capture: { ...DEFAULT_CONFIG.capture, filterMinSize: 1 },
};

describe('memtreeBash', () => {
  test('denylist rejects env command', async () => {
    await expect(
      memtreeBash(db, trustedConfig, { command: 'env' })
    ).rejects.toBeInstanceOf(McpError);

    try {
      await memtreeBash(db, trustedConfig, { command: 'env' });
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).message).toContain('rejected by denylist');
    }
  });

  test('denylist rejects printenv HOME', async () => {
    await expect(
      memtreeBash(db, trustedConfig, { command: 'printenv HOME' })
    ).rejects.toBeInstanceOf(McpError);

    try {
      await memtreeBash(db, trustedConfig, { command: 'printenv HOME' });
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).message).toContain('rejected by denylist');
    }
  });

  test('trustedExecution=false (default) throws documented error', async () => {
    const untrustedConfig = { ...DEFAULT_CONFIG, trustedExecution: false };

    try {
      await memtreeBash(db, untrustedConfig, { command: 'echo hello' });
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).message).toContain('trustedExecution: true');
    }
  });

  test('normal command with trustedExecution=true stores a DB row', async () => {
    const result = await memtreeBash(db, trustedConfig, { command: 'echo hello world' });

    expect(result.nodeId).toBeTruthy();
    expect(result.exit_code).toBe(0);
    expect(result.stdout.trim()).toContain('hello world');

    const node = db
      .query("SELECT * FROM nodes WHERE id = ? AND kind = 'tool_output'")
      .get(result.nodeId) as { metadata: string } | null;

    expect(node).not.toBeNull();
    const meta = JSON.parse(node!.metadata) as { tool: string };
    expect(meta.tool).toBe('Bash');
  });

  test('output redaction removes secrets before storage', async () => {
    // Constructed to match the AWS key pattern without being a literal that triggers scanners
    const awsKey = 'AKIA' + '1234567890ABCDEF';
    const result = await memtreeBash(db, trustedConfig, {
      command: `echo '${awsKey}'`,
    });

    // Verify redactBashOutput would catch this pattern
    const redacted = redactBashOutput(awsKey);
    expect(redacted).not.toContain(awsKey);

    // The stored node content should not contain the raw key
    const node = db
      .query("SELECT * FROM nodes WHERE id = ?")
      .get(result.nodeId) as { content: string } | null;

    if (node) {
      expect(node.content).not.toContain(awsKey);
    }

    // stdout returned should also be redacted
    expect(result.stdout).not.toContain(awsKey);
  });

  test('non-zero exit code is stored, not re-thrown', async () => {
    const result = await memtreeBash(db, trustedConfig, {
      command: "bash -c 'exit 42'",
    });

    expect(result.exit_code).toBe(42);
  });
});
