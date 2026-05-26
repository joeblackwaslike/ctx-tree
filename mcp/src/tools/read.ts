import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { extname } from 'node:path';
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
  nodeIds: string[];
  content: string;
  truncated: boolean;
  chunking: 'treesitter' | 'window';
}

interface Chunk {
  startLine: number;
  endLine: number;
  content: string;
  symbolName: string;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function windowChunk(lines: string[], windowSize = 200): Chunk[] {
  const chunks: Chunk[] = [];
  for (let i = 0; i < lines.length; i += windowSize) {
    const slice = lines.slice(i, i + windowSize);
    const startLine = i + 1;
    const endLine = i + slice.length;
    chunks.push({ startLine, endLine, content: slice.join('\n'), symbolName: `L${startLine}-${endLine}` });
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
      text: string;
      startPosition: { row: number };
      endPosition: { row: number };
      childCount: number;
      children: TSNode[];
      childForFieldName(field: string): TSNode | null;
    };

    // Classes are containers — recurse into them to capture individual methods.
    const LEAF_TYPES = new Set([
      'function_declaration', 'method_definition',
      'lexical_declaration', 'variable_declaration', 'export_statement',
      'function_definition',
      'function_item', 'struct_item', 'enum_item', 'impl_item',
    ]);

    function extractSymbolName(node: TSNode): string {
      // BFS up to depth 3 to find the declared identifier, even for wrapped nodes
      // like export_statement → lexical_declaration → variable_declarator → name.
      type QItem = { n: TSNode; depth: number };
      const queue: QItem[] = [{ n: node, depth: 0 }];
      while (queue.length > 0) {
        const { n, depth } = queue.shift()!;
        const nameNode = n.childForFieldName('name');
        if (nameNode) return nameNode.text;
        if (depth >= 3) continue;
        for (const child of n.children) {
          if (child.type === 'identifier' || child.type === 'property_identifier') return child.text;
          queue.push({ n: child, depth: depth + 1 });
        }
      }
      return node.type;
    }

    function walk(node: TSNode) {
      if (LEAF_TYPES.has(node.type)) {
        const startLine = node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;
        const content = lines.slice(startLine - 1, endLine).join('\n');
        chunks.push({ startLine, endLine, content, symbolName: extractSymbolName(node) });
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

  // Stale any cached reads of this file whose mtime no longer matches.
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

  const nodeIds: string[] = [];

  // Deduplicate symbol names within this read (e.g. two anonymous export_statement nodes).
  // Collisions get a :L<startLine> suffix to keep URIs stable and unique.
  const seenNames = new Set<string>();
  function uniqueSymbolKey(chunk: Chunk): string {
    if (!seenNames.has(chunk.symbolName)) {
      seenNames.add(chunk.symbolName);
      return chunk.symbolName;
    }
    return `${chunk.symbolName}:L${chunk.startLine}`;
  }

  for (const chunk of included) {
    const chunkUri = `file://${path}#${uniqueSymbolKey(chunk)}`;
    const contentHash = createHash('sha256').update(chunk.content).digest('hex');

    const cached = getNodeBySourceUri(db, chunkUri);
    if (cached && cached.mtime === mtime) {
      nodeIds.push(cached.id);
      continue;
    }

    if (cached) updateNodeStatus(db, cached.id, 'stale');

    const nodeId = ulid();
    insertNode(db, nodeId, {
      parent_id: null,
      kind: 'file_chunk',
      source_uri: chunkUri,
      content: chunk.content,
      content_hash: contentHash,
      status: 'live',
      mtime,
      truncated: truncated ? 1 : 0,
      original_bytes: originalBytes,
      metadata: JSON.stringify({ filePath: path, chunking, symbolName: chunk.symbolName }),
    });

    if (cached) insertEdge(db, { src_id: nodeId, dst_id: cached.id, kind: 'supersedes' });

    nodeIds.push(nodeId);
  }

  const content = included.map(c => c.content).join('\n\n');
  return { nodeIds, content, truncated, chunking };
}
