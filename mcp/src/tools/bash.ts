import { execSync, type SpawnSyncError } from 'child_process';
import { createHash } from 'crypto';
import { ulid } from 'ulid';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Database } from 'bun:sqlite';
import type { MemtreeConfig } from '../store/types.js';
import { shouldDropBashCommand, redactBashOutput } from '../redaction/index.js';
import { insertNode } from '../store/nodes.js';

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
  db: Database,
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
    rawStdout = execSync(command, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: unknown) {
    // execSync throws on non-zero exit — extract details from the error object
    const spawnErr = err as SpawnSyncError<string>;
    rawStdout = spawnErr.stdout ?? '';
    rawStderr = spawnErr.stderr ?? '';
    exit_code = spawnErr.status ?? 1;
  }

  // 4. Redaction
  const redactedStdout = redactBashOutput(rawStdout);
  const redactedStderr = redactBashOutput(rawStderr);

  // 5. Budget: apply token budget as char limit
  const charBudget = budget_tokens * 4;
  let truncated = false;
  let truncatedStdout = redactedStdout;
  if (truncatedStdout.length > charBudget) {
    truncatedStdout = truncatedStdout.slice(0, charBudget);
    truncated = true;
  }

  // Also enforce config.capture.maxBytes hard cap
  const maxBytes = config.capture.maxBytes;
  if (truncatedStdout.length > maxBytes) {
    truncatedStdout = truncatedStdout.slice(0, maxBytes);
    truncated = true;
  }

  // 6. Store in DB
  const content = truncatedStdout || redactedStderr;
  const nodeId = ulid();

  if (content.length >= config.capture.filterMinSize) {
    const commandHash = createHash('sha256').update(command).digest('hex').slice(0, 8);
    const contentHash = createHash('sha256').update(content).digest('hex');
    const originalBytes = Buffer.byteLength(content, 'utf8');

    insertNode(db, nodeId, {
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
