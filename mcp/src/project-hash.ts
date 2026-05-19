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

const PROJECTS_TSV = join(homedir(), '.memtree', 'projects.tsv');

/**
 * Register a project in ~/.memtree/projects.tsv.
 * If the cwd already exists, update its hash.
 * Otherwise, append a new line.
 * Writes atomically via a temp file + rename.
 */
export function registerProject(cwd: string, hash: string): void {
  const lines: string[] = [];
  
  try {
    const content = readFileSync(PROJECTS_TSV, 'utf-8');
    lines.push(...content.split('\n').filter(line => line.trim()));
  } catch {
    // File doesn't exist yet, start fresh
  }

  // Check if cwd already exists and update or add
  const cwdIndex = lines.findIndex(line => line.split('\t')[0] === cwd);
  if (cwdIndex >= 0) {
    lines[cwdIndex] = `${cwd}\t${hash}`;
  } else {
    lines.push(`${cwd}\t${hash}`);
  }

  // Ensure the directory exists
  const tsvDir = join(homedir(), '.memtree');
  try {
    mkdirSync(tsvDir, { recursive: true, mode: 0o700 });
  } catch {
    // Directory already exists
  }

  // Write atomically: write to a temp file, then rename
  const tmpPath = `${PROJECTS_TSV}.tmp`;
  const content = lines.join('\n') + '\n';
  writeFileSync(tmpPath, content, 'utf-8');
  
  // Atomic rename
  renameSync(tmpPath, PROJECTS_TSV);
}

/**
 * Deregister a project from ~/.memtree/projects.tsv by removing its hash entry.
 */
export function deregisterProject(hash: string): void {
  try {
    const content = readFileSync(PROJECTS_TSV, 'utf-8');
    const lines = content
      .split('\n')
      .filter(line => line.trim())
      .filter(line => line.split('\t')[1] !== hash);
    
    const newContent = lines.join('\n') + (lines.length > 0 ? '\n' : '');
    
    // Write atomically: write to a temp file, then rename
    const tmpPath = `${PROJECTS_TSV}.tmp.${process.pid}`;
    writeFileSync(tmpPath, newContent, 'utf-8');
    
    // Atomic rename
    renameSync(tmpPath, PROJECTS_TSV);
  } catch {
    // File doesn't exist, nothing to deregister
  }
}

/**
 * Resolve the hash for a given cwd from ~/.memtree/projects.tsv.
 * Returns the hash or null if not found.
 */
export function resolveProjectHash(cwd: string): string | null {
  try {
    const content = readFileSync(PROJECTS_TSV, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());
    for (const line of lines) {
      const [lineCwd, hash] = line.split('\t');
      if (lineCwd === cwd) {
        return hash || null;
      }
    }
  } catch {
    // File doesn't exist
  }
  return null;
}
