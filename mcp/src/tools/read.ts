import { readFileSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { ulid } from 'ulid';
import { extname } from 'path';
import type { Database } from 'bun:sqlite';
import type { MemtreeConfig } from '../store/types';
import { insertNode, getNodeBySourceUri, updateNodeStatus, markStaleByFilePath } from '../store/nodes';
import { insertEdge } from '../store/edges';
import { shouldDropPath } from '../redaction';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

export interface ReadParams {
  path: string;
  lines?: [number, number];
  budget_tokens?: number;
}

export interface ReadResult {
  nodeId: string;
  content: string;
  truncated: boolean;
  chunking: 'treesitter' | 'window';
}

interface Chunk {
  startLine: number;
  endLine: number;
  content: string;
  symbolName?: string;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function windowChunk(lines: string[], windowSize = 200): Chunk[] {
  const chunks: Chunk[] = [];
  for (let i = 0; i < lines.length; i += windowSize) {
    const slice = lines.slice(i, i + windowSize);
    chunks.push({ startLine: i + 1, endLine: i + slice.length, content: slice.join('\n') });
  }
  return chunks;
}

type TreeSitterLanguage = { [key: string]: unknown };

const LANG_MAP: Record<string, () => TreeSitterLanguage> = {
  '.ts': () => require('tree-sitter-typescript').typescript,
  '.tsx': () => require('tree-sitter-typescript').tsx,
  '.js': () => require('tree-sitter-javascript'),
  '.jsx': () => require('tree-sitter-javascript'),
  '.py': () => require('tree-sitter-python'),
  '.rs': () => require('tree-sitter-rust'),
  '.go': () => require('tree-sitter-go'),
  '.sh': () => require('tree-sitter-bash'),
};

function treeSitterChunk(source: string, lang: TreeSitterLanguage): Chunk[] {
  try {
    const Parser = require('tree-sitter');
    const parser = new Parser();
    parser.setLanguage(lang);
    const tree = parser.parse(source);
    const lines = source.split('\n');
    const chunks: Chunk[] = [];

    type TSNode = {
      type: string;
      startPosition: { row: number };
      endPosition: { row: number };
      childCount: number;
      children: TSNode[];
    };

    // Classes are containers — recurse into them to capture individual methods.
    const LEAF_TYPES = new Set([
      'function_declaration', 'method_definition',
      'lexical_declaration', 'variable_declaration', 'export_statement',
      'function_definition',
      'function_item', 'struct_item', 'enum_item', 'impl_item',
    ]);

    function walk(node: TSNode) {
      if (LEAF_TYPES.has(node.type)) {
        const startLine = node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;
        const content = lines.slice(startLine - 1, endLine).join('\n');
        chunks.push({ startLine, endLine, content, symbolName: node.type });
        return;
      }
      if (node.childCount > 0) {
        for (const child of node.children) walk(child);
      }
    }

    walk(tree.rootNode);
    return chunks.length > 0 ? chunks : windowChunk(lines);
  } catch {
    return windowChunk(source.split('\n'));
  }
}

export async function memtreeRead(
  db: Database,
  config: MemtreeConfig,
  params: ReadParams
): Promise<ReadResult> {
  const { path, lines, budget_tokens = 2000 } = params;

  if (shouldDropPath(path, config.capture.pathDenylistExtra ?? [])) {
    throw new Error(`Path rejected by denylist: ${path}`);
  }

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    throw new McpError(ErrorCode.InvalidParams, `File not found or inaccessible: ${path}`);
  }
  const mtime = Math.round(stat.mtimeMs);
  const ext = extname(path).toLowerCase();

  // Cache key includes lines and budget to avoid returning wrong cached content.
  const lineKey = lines ? `${lines[0]},${lines[1]}` : 'all';
  const cacheUri = `file://${path}?lines=${lineKey}&budget=${budget_tokens}`;

  const cached = getNodeBySourceUri(db, cacheUri);
  if (cached && cached.mtime === mtime) {
    const meta = JSON.parse(cached.metadata) as { chunking: 'treesitter' | 'window' };
    return { nodeId: cached.id, content: cached.content, truncated: cached.truncated === 1, chunking: meta.chunking };
  }

  if (cached) updateNodeStatus(db, cached.id, 'stale');
  // Stale any other cached reads of this file whose mtime no longer matches.
  markStaleByFilePath(db, path, mtime);

  let raw = readFileSync(path, 'utf8');
  const originalBytes = Buffer.byteLength(raw, 'utf8');
  let truncated = false;
  if (originalBytes > config.capture.maxBytes) {
    raw = raw.slice(0, config.capture.maxBytes);
    truncated = true;
  }

  const langLoader = LANG_MAP[ext];
  let chunks: Chunk[];
  let chunking: 'treesitter' | 'window';

  if (langLoader) {
    try {
      const lang = langLoader();
      chunks = treeSitterChunk(raw, lang);
      chunking = 'treesitter';
    } catch {
      chunks = windowChunk(raw.split('\n'));
      chunking = 'window';
    }
  } else {
    chunks = windowChunk(raw.split('\n'));
    chunking = 'window';
  }

  if (lines) {
    // Schema advertises 0-based lines; internal chunks use 1-based line numbers.
    const start1 = lines[0] + 1;
    const end1 = lines[1] + 1;
    chunks = chunks.filter(c => c.startLine <= end1 && c.endLine >= start1);
  }

  const budget = budget_tokens;
  let used = 0;
  const included: Chunk[] = [];
  for (const [i, chunk] of chunks.entries()) {
    const tokens = estimateTokens(chunk.content);
    // Always include at least the first chunk so callers get some content.
    if (i > 0 && used + tokens > budget) break;
    included.push(chunk);
    used += tokens;
  }

  const content = included.map(c => c.content).join('\n\n');
  const contentHash = createHash('sha256').update(content).digest('hex');
  const nodeId = ulid();

  insertNode(db, nodeId, {
    parent_id: null,
    kind: 'file_chunk',
    source_uri: cacheUri,
    content,
    content_hash: contentHash,
    status: 'live',
    mtime,
    truncated: truncated ? 1 : 0,
    original_bytes: originalBytes,
    metadata: JSON.stringify({ filePath: path, chunking, chunkCount: included.length }),
  });

  if (cached) insertEdge(db, { src_id: nodeId, dst_id: cached.id, kind: 'supersedes' });

  return { nodeId, content, truncated, chunking };
}
