import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { StoreBackend } from '../store/index.js';
import type { CtxTreeConfig } from '../store/types.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

export interface NoteParams {
  content: string;
  title?: string;
}

export interface NoteResult {
  nodeId: string;
  title: string;
  preview: string;
}

export async function ctxTreeNote(
  store: StoreBackend,
  _config: CtxTreeConfig,
  params: NoteParams,
): Promise<NoteResult> {
  const { content, title } = params;

  if (!content || typeof content !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, '"content" is required and must be a string');
  }

  const derivedTitle = title?.trim() || content.split('\n')[0].slice(0, 80);
  const nodeId       = ulid();
  const contentHash  = createHash('sha256').update(content).digest('hex');

  await store.insertNode(nodeId, {
    parent_id:      null,
    kind:           'note',
    source_uri:     `note://${contentHash.slice(0, 16)}`,
    content,
    content_hash:   contentHash,
    status:         'live',
    mtime:          Date.now(),
    truncated:      0,
    original_bytes: Buffer.byteLength(content, 'utf8'),
    metadata:       JSON.stringify({ title: derivedTitle }),
  });

  return {
    nodeId,
    title:   derivedTitle,
    preview: content.slice(0, 200),
  };
}
