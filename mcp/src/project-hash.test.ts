import { describe, test, expect } from 'bun:test';
import { computeProjectHash } from './project-hash';

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
