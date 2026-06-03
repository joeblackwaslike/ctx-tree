import { exec } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { ulid } from 'ulid';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { StoreBackend } from '../store/index.js';
import type { MemtreeConfig } from '../store/types.js';
import { shouldDropBashCommand, redactBashOutput } from '../redaction/index.js';

const execAsync = promisify(exec);

export interface BashParams {
  command: string;
  budget_tokens?: number;
}

export interface BashResult {
  nodeId: string;
  stdout: string;
  stderr: string;
  exit_code: number;
  truncated: boolean;
}

export async function memtreeBash(
  store: StoreBackend,
  config: MemtreeConfig,
  params: BashParams
): Promise<BashResult> {
  const { command, budget_tokens = 2000 } = params;

  // 1. Denylist check first
  if (shouldDropBashCommand(command)) {
    throw new McpError(ErrorCode.InvalidParams, `Command rejected by denylist: ${command}`);
  }

  // 2. trustedExecution gate
  if (!config.trustedExecution) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'memtree.bash requires trustedExecution: true in config. Set this only in trusted local environments.'
    );
  }

  // 3. Execute command — command is passed as a raw string to sh -c.
  // Input sanitization beyond the denylist is delegated to the caller's sandbox
  // (e.g., Claude Code's permission system). This function must only be reachable
  // via trustedExecution=true, which gates access to privileged deployments.
  let rawStdout = '';
  let rawStderr = '';
  let exit_code = 0;

  try {
    const result = await execAsync(command, {
      encoding: 'utf8',
      maxBuffer: 100 * 1024 * 1024,
    });
    rawStdout = result.stdout;
    rawStderr = result.stderr;
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number };
    rawStdout = execErr.stdout ?? '';
    rawStderr = execErr.stderr ?? '';
    exit_code = execErr.code ?? 1;
  }

  // 4. Redaction
  const redactedStdout = redactBashOutput(rawStdout);
  const redactedStderr = redactBashOutput(rawStderr);

  // 5. Budget: capture original byte size, then enforce maxBytes cap (byte-accurate),
  // then apply token budget as a char limit on the already byte-limited string.
  const maxBytes = config.capture.maxBytes;
  const charBudget = budget_tokens * 4;
  let truncated = false;
  let truncatedStdout = redactedStdout;

  const originalBytes = Buffer.byteLength(redactedStdout, 'utf8');

  if (originalBytes > maxBytes) {
    let low = 0, high = truncatedStdout.length;
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if (Buffer.byteLength(truncatedStdout.slice(0, mid), 'utf8') <= maxBytes) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    truncatedStdout = truncatedStdout.slice(0, low);
    truncated = true;
  }

  if (truncatedStdout.length > charBudget) {
    truncatedStdout = truncatedStdout.slice(0, charBudget);
    truncated = true;
  }

  // 6. Store in DB
  const content = truncatedStdout || redactedStderr;
  const nodeId = ulid();

  if (content.length >= config.capture.filterMinSize) {
    const commandHash = createHash('sha256').update(command).digest('hex').slice(0, 8);
    const contentHash = createHash('sha256').update(content).digest('hex');

    await store.insertNode(nodeId, {
      parent_id: null,
      kind: 'tool_output',
      source_uri: `tool:Bash#${commandHash}`,
      content,
      content_hash: contentHash,
      status: 'live',
      mtime: 0,
      truncated: truncated ? 1 : 0,
      original_bytes: originalBytes,
      metadata: JSON.stringify({ tool: 'Bash', command, exit_code }),
    });
  }

  // 7. Return result
  return {
    nodeId,
    stdout: truncatedStdout,
    stderr: redactedStderr,
    exit_code,
    truncated,
  };
}
