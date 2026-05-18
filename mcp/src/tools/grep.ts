import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { MemtreeConfig } from '../store/types';
import { insertNode } from '../store/nodes';
import { shouldDropPath } from '../redaction';

export interface GrepParams {
  pattern: string;
  path?: string;
  caseInsensitive?: boolean;
  fileGlob?: string;
  maxCount?: number;
}

export interface GrepResult {
  nodeId: string;
  matches: string[];
}

export async function memtreeGrep(
  db: Database,
  config: MemtreeConfig,
  params: GrepParams
): Promise<GrepResult> {
  const { pattern, path = '.', caseInsensitive, fileGlob, maxCount = 500 } = params;

  if (shouldDropPath(path, config.capture.pathDenylistExtra ?? [])) {
    throw new Error(`Path rejected by denylist: ${path}`);
  }

  const args: string[] = ['rg', '--line-number', '--no-heading'];
  if (caseInsensitive) args.push('-i');
  if (fileGlob) args.push('--glob', fileGlob);
  args.push('--max-count', String(maxCount));
  args.push('--', pattern, path);

  let rawOutput = '';
  const result = spawnSync('rg', args.slice(1), {
    maxBuffer: config.capture.maxBytes,
    encoding: 'buffer',
  });

  if (result.status === null) {
    throw new Error(`rg failed to start: ${result.error}`);
  } else if (result.status === 0 || result.status === 1) {
    rawOutput = result.stdout?.toString('utf8') ?? '';
  } else {
    throw new Error(`rg failed with exit code ${result.status}: ${result.stderr?.toString('utf8')}`);
  }

  const matches = rawOutput.split('\n').filter(Boolean);
  const content = matches.join('\n');
  const originalBytes = Buffer.byteLength(content, 'utf8');
  const truncContent = Buffer.from(content).subarray(0, config.capture.maxBytes).toString('utf8');
  const contentHash = createHash('sha256').update(truncContent).digest('hex');
  const nodeId = ulid();

  if (Buffer.byteLength(content, 'utf8') >= config.capture.filterMinSize) {
    insertNode(db, nodeId, {
      parent_id: null,
      kind: 'tool_output',
      source_uri: `tool:Grep#${contentHash.slice(0, 8)}`,
      content: truncContent,
      content_hash: contentHash,
      status: 'live',
      mtime: 0,
      truncated: originalBytes > config.capture.maxBytes ? 1 : 0,
      original_bytes: originalBytes,
      metadata: JSON.stringify({ tool: 'Grep', pattern, path }),
    });

    // Create child file_chunk nodes per matched file
    const matchedFiles = new Set(
      matches.map(line => {
        const colonIdx = line.indexOf(':');
        return colonIdx > 0 ? line.slice(0, colonIdx) : null;
      }).filter((f): f is string => f !== null && !shouldDropPath(f, config.capture.pathDenylistExtra ?? []))
    );

    for (const filePath of matchedFiles) {
      const prefix = filePath + ':';
      const fileLines = matches.filter(l => l.startsWith(prefix) && /^\d+:/.test(l.slice(prefix.length)));
      const fileContent = fileLines.join('\n');
      if (Buffer.byteLength(fileContent, 'utf8') < config.capture.filterMinSize) continue;
      const fileHash = createHash('sha256').update(fileContent).digest('hex');
      insertNode(db, ulid(), {
        parent_id: nodeId,
        kind: 'file_chunk',
        source_uri: `file://${filePath}`,
        content: fileContent,
        content_hash: fileHash,
        status: 'live',
        mtime: 0,
        truncated: 0,
        original_bytes: Buffer.byteLength(fileContent, 'utf8'),
        metadata: JSON.stringify({ tool: 'Grep', pattern, filePath }),
      });
    }
  }

  return { nodeId, matches };
}
