import { execSync } from 'child_process';
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
  try {
    rawOutput = execSync(args.join(' '), {
      maxBuffer: config.capture.maxBytes,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString('utf8');
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: Buffer };
    if (e.status === 1) {
      rawOutput = e.stdout?.toString('utf8') ?? '';
    } else if ((e.status ?? 0) > 1) {
      throw new Error(`rg failed: ${err}`);
    }
  }

  const matches = rawOutput.split('\n').filter(Boolean);
  const content = matches.join('\n');
  const originalBytes = Buffer.byteLength(content, 'utf8');
  const truncContent = content.slice(0, config.capture.maxBytes);
  const contentHash = createHash('sha256').update(truncContent).digest('hex');
  const nodeId = ulid();

  if (content.length >= config.capture.filterMinSize) {
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
  }

  return { nodeId, matches };
}
