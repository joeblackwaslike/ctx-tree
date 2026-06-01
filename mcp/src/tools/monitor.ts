import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { StoreBackend } from '../store/index.js';
import type { MemtreeConfig } from '../store/types.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { redactBashOutput } from '../redaction';

export interface MonitorParams {
  command: string;
  timeout_ms?: number;   // default 30_000
  cwd?: string;
}

export interface MonitorResult {
  nodeId: string;
  command: string;
  exit_code: number;
  lines_captured: number;
  preview: string;       // last ~500 chars of output
  cached: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const PREVIEW_CHARS = 500;

export async function memtreeMonitor(
  store: StoreBackend,
  _config: MemtreeConfig,
  params: MonitorParams,
): Promise<MonitorResult> {
  const { command, timeout_ms = DEFAULT_TIMEOUT_MS, cwd } = params;

  if (!command || typeof command !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, '"command" is required and must be a string');
  }

  const sourceUri = `cmd://${createHash('sha256').update(command).digest('hex').slice(0, 16)}`;

  // Run the command
  let output: string;
  let exitCode: number;
  try {
    const proc = Bun.spawn(['sh', '-c', command], {
      cwd: cwd ?? process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const timeoutId = setTimeout(() => proc.kill(), timeout_ms);

    const [stdoutBuf, stderrBuf] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    exitCode = await proc.exited;
    clearTimeout(timeoutId);

    output = redactBashOutput(stdoutBuf + (stderrBuf ? `\n[stderr]\n${stderrBuf}` : ''));
  } catch (err) {
    throw new McpError(ErrorCode.InternalError, `Failed to run command: ${(err as Error).message}`);
  }

  const contentHash = createHash('sha256').update(output).digest('hex');
  const lines = output.split('\n');
  const preview = output.slice(-PREVIEW_CHARS);

  // Check for existing node with identical output
  const existing = await store.getNodeBySourceUri(sourceUri);
  if (existing) {
    if (existing.content_hash === contentHash) {
      return {
        nodeId: existing.id,
        command,
        exit_code: exitCode,
        lines_captured: lines.length,
        preview,
        cached: true,
      };
    }
    await store.updateNodeStatus(existing.id, 'stale');
  }

  const nodeId = ulid();
  await store.insertNode(nodeId, {
    parent_id: null,
    kind: 'tool_output',
    source_uri: sourceUri,
    content: output,
    content_hash: contentHash,
    status: 'live',
    mtime: Date.now(),
    truncated: 0,
    original_bytes: Buffer.byteLength(output, 'utf8'),
    metadata: JSON.stringify({ command, exit_code: exitCode, cwd: cwd ?? process.cwd() }),
  });

  if (existing) {
    await store.insertEdge({ src_id: nodeId, dst_id: existing.id, kind: 'supersedes' });
  }

  return {
    nodeId,
    command,
    exit_code: exitCode,
    lines_captured: lines.length,
    preview,
    cached: false,
  };
}
