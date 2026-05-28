import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * Matches computeProjectHash() in mcp/src/project-hash.ts.
 * Both hooks and the MCP server must use this function to open the same DB.
 *
 * For git repos: sha256(gitRoot + ":" + firstCommit).slice(0,16)
 * Fallback for non-git paths: sha256(cwd).slice(0,16)
 */
export function computeProjectHash(cwd) {
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
