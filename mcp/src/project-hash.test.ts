import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { computeProjectHash, registerProject, deregisterProject, resolveProjectHash } from './project-hash';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('computeProjectHash', () => {
  test('returns 16-char hex string for a git repo', () => {
    const hash = computeProjectHash(process.cwd());
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test('returns 16-char hex string for a non-git path', () => {
    const hash = computeProjectHash('/tmp/not-a-repo');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test('different paths produce different hashes', () => {
    const a = computeProjectHash('/tmp/project-a');
    const b = computeProjectHash('/tmp/project-b');
    expect(a).not.toBe(b);
  });
});

describe('computeProjectHash determinism', () => {
  test('same repo path always gives same hash', () => {
    const a = computeProjectHash(process.cwd());
    const b = computeProjectHash(process.cwd());
    expect(a).toBe(b);
  });
});

describe('registerProject, deregisterProject, resolveProjectHash', () => {
  let tmpDir: string;
  
  beforeEach(() => {
    // Create a temporary directory for each test
    tmpDir = mkdtempSync(join(tmpdir(), 'memtree-test-'));
    process.env.MEMTREE_HOME = tmpDir;
  });

  afterEach(() => {
    // Clean up the temp directory after each test
    delete process.env.MEMTREE_HOME;
    try {
      rmSync(tmpDir, { recursive: true });
    } catch {
      // Directory already removed or doesn't exist
    }
  });

  test('registerProject creates projects.tsv if missing', () => {
    const cwd = '/tmp/test-project-1';
    const hash = 'abc123def456789';
    registerProject(cwd, hash);
    
    const resolved = resolveProjectHash(cwd);
    expect(resolved).toBe(hash);
  });

  test('registerProject appends new entry', () => {
    const cwd1 = '/tmp/test-project-1';
    const hash1 = 'hash1111111111';
    const cwd2 = '/tmp/test-project-2';
    const hash2 = 'hash2222222222';
    
    registerProject(cwd1, hash1);
    registerProject(cwd2, hash2);
    
    expect(resolveProjectHash(cwd1)).toBe(hash1);
    expect(resolveProjectHash(cwd2)).toBe(hash2);
  });

  test('registerProject updates existing entry for same cwd', () => {
    const cwd = '/tmp/test-project';
    const hash1 = 'hash1111111111';
    const hash2 = 'hash2222222222';
    
    registerProject(cwd, hash1);
    expect(resolveProjectHash(cwd)).toBe(hash1);
    
    registerProject(cwd, hash2);
    expect(resolveProjectHash(cwd)).toBe(hash2);
  });

  test('deregisterProject removes the correct entry, leaves others', () => {
    const cwd1 = '/tmp/test-project-1';
    const hash1 = 'hash1111111111';
    const cwd2 = '/tmp/test-project-2';
    const hash2 = 'hash2222222222';
    
    registerProject(cwd1, hash1);
    registerProject(cwd2, hash2);
    
    deregisterProject(hash1);
    
    expect(resolveProjectHash(cwd1)).toBeNull();
    expect(resolveProjectHash(cwd2)).toBe(hash2);
  });

  test('resolveProjectHash returns hash for exact cwd match', () => {
    const cwd = '/tmp/test-project';
    const hash = 'abc123def456789';
    registerProject(cwd, hash);
    
    expect(resolveProjectHash(cwd)).toBe(hash);
  });

  test('resolveProjectHash returns null for unknown cwd', () => {
    registerProject('/tmp/test-project', 'hash1111111111');
    
    expect(resolveProjectHash('/tmp/unknown-project')).toBeNull();
  });

  test('registerProject creates missing MEMTREE_HOME directory', () => {
    // Remove the temp directory to simulate missing ~/.memtree/
    rmSync(tmpDir, { recursive: true });
    
    const cwd = '/tmp/test-project-missing-dir';
    const hash = 'hashABCD1234567';
    
    // This should succeed and create the directory
    registerProject(cwd, hash);
    
    expect(resolveProjectHash(cwd)).toBe(hash);
  });
});
