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

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

function getProjectsTsvPath(): string {
  const memtreeHome = process.env.MEMTREE_HOME ?? join(homedir(), '.memtree');
  return join(memtreeHome, 'projects.tsv');
}

/**
 * Read all entries from projects.tsv as [cwd, hash] tuples.
 * Returns an empty array if the file doesn't exist.
 */
function readEntries(): Array<[string, string]> {
  const PROJECTS_TSV = getProjectsTsvPath();
  try {
    const content = readFileSync(PROJECTS_TSV, 'utf-8');
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        const [cwd, hash] = line.split('\t');
        return [cwd, hash] as [string, string];
      });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Write all entries to projects.tsv atomically via temp file + rename.
 * Ensures ~/.memtree/ directory exists beforehand.
 *
 * Note: Not safe against concurrent read-modify-write across processes.
 * Multiple processes could both read, both modify, and both rename — last
 * one wins. However, data is advisory; stale entries are survivable.
 */
function writeEntries(entries: Array<[string, string]>): void {
  const PROJECTS_TSV = getProjectsTsvPath();
  
  // Ensure the directory exists
  const memtreeHome = process.env.MEMTREE_HOME ?? join(homedir(), '.memtree');
  try {
    mkdirSync(memtreeHome, { recursive: true, mode: 0o700 });
  } catch {
    // Directory already exists
  }

  // Write atomically: write to a temp file, then rename
  const tmpPath = `${PROJECTS_TSV}.tmp.${process.pid}`;
  const content = entries.map(([cwd, hash]) => `${cwd}\t${hash}`).join('\n');
  const finalContent = entries.length > 0 ? content + '\n' : '';
  writeFileSync(tmpPath, finalContent, 'utf-8');
  
  // Atomic rename
  renameSync(tmpPath, PROJECTS_TSV);
}

/**
 * Register a project in ~/.memtree/projects.tsv.
 * If the cwd already exists, update its hash.
 * Otherwise, append a new line.
 * Writes atomically via a temp file + rename.
 */
export function registerProject(cwd: string, hash: string): void {
  const entries = readEntries();
  
  // Check if cwd already exists and update or add
  const existingIndex = entries.findIndex(([cwdEntry]) => cwdEntry === cwd);
  if (existingIndex >= 0) {
    entries[existingIndex] = [cwd, hash];
  } else {
    entries.push([cwd, hash]);
  }

  writeEntries(entries);
}

/**
 * Deregister a project from ~/.memtree/projects.tsv by removing its hash entry.
 */
export function deregisterProject(hash: string): void {
  const entries = readEntries();
  const filtered = entries.filter(([, hashEntry]) => hashEntry !== hash);
  writeEntries(filtered);
}

/**
 * Resolve the hash for a given cwd from ~/.memtree/projects.tsv.
 * Returns the hash or null if not found.
 */
export function resolveProjectHash(cwd: string): string | null {
  const entries = readEntries();
  for (const [cwdEntry, hash] of entries) {
    if (cwdEntry === cwd) {
      return hash || null;
    }
  }
  return null;
}
