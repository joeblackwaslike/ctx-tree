import { execSync } from 'child_process';
import { createHash } from 'crypto';

export function computeProjectHash(cwd: string): string {
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
    const firstCommit = execSync('git rev-list --max-parents=0 HEAD', {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
    return createHash('sha256')
      .update(`${gitRoot}:${firstCommit}`)
      .digest('hex')
      .slice(0, 16);
  } catch {
    return createHash('sha256').update(cwd).digest('hex').slice(0, 16);
  }
}
