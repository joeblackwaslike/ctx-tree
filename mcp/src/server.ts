import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { execSync } from 'child_process';
import { mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { openDb, closeDb } from './store/db.js';
import { loadConfig } from './config.js';
import { computeProjectHash } from './project-hash.js';
import { WalkerCoordinator } from './walkers/coordinator.js';
import { searchKeyword } from './tools/search.js';
import { getNeighborsDeep } from './tools/neighbors.js';
import { getPathToRoot } from './tools/path-to-root.js';
import { getRecent } from './tools/recent.js';
import { memtreeRead } from './tools/read.js';
import { memtreeGrep } from './tools/grep.js';
import { memtreeCompose } from './tools/compose.js';
import { memtreeBrowse } from './tools/browse.js';
import { memtreeMonitor } from './tools/monitor.js';
import { memtreeNote } from './tools/note.js';
import type { Filters } from './store/types.js';

// ── Platform check ────────────────────────────────────────────────────────────
const SUPPORTED_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];
const rawPlatform = `${process.platform}-${process.arch}`;
const platform = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
const effectivePlatform = SUPPORTED_PLATFORMS.includes(rawPlatform)
  ? rawPlatform
  : SUPPORTED_PLATFORMS.includes(platform)
  ? platform
  : null;

if (!effectivePlatform) {
  process.stderr.write(
    `memtree: unsupported platform ${rawPlatform}\n` +
      `Supported platforms: ${SUPPORTED_PLATFORMS.join(', ')}\n`,
  );
  process.exit(1);
}

// ── ripgrep check ─────────────────────────────────────────────────────────────
try {
  execSync('rg --version', { stdio: 'pipe' });
} catch {
  process.stderr.write(
    'memtree: `rg` (ripgrep) is not installed or not in PATH.\n' +
      'Install it via: brew install ripgrep  (macOS) or  apt install ripgrep  (Debian/Ubuntu)\n',
  );
  process.exit(1);
}

// ── DB path setup ─────────────────────────────────────────────────────────────
const projectHash = computeProjectHash(process.env.MEMTREE_CWD ?? process.cwd());
const storeDir = join(process.env.HOME ?? '/tmp', '.memtree', projectHash);
const dbPath = join(storeDir, 'store.db');

mkdirSync(storeDir, { recursive: true, mode: 0o700 });

const config = loadConfig(process.env.MEMTREE_CWD ?? process.cwd());
const db = openDb(dbPath);
chmodSync(dbPath, 0o600);

// ── Walkers ───────────────────────────────────────────────────────────────────
const walkers = new WalkerCoordinator();
walkers.start(db, config);

// ── MCP server ────────────────────────────────────────────────────────────────
const server = new Server(
  { name: 'memtree', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'memtree_search',
      description: 'Keyword search over the memtree store.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          mode: { type: 'string', enum: ['keyword'], description: 'Search mode (only "keyword" supported)' },
          limit: { type: 'number', description: 'Max results to return' },
          filters: { type: 'object', description: 'Optional filters' },
        },
        required: ['query'],
      },
    },
    {
      name: 'memtree_neighbors',
      description: 'Graph walk from a node, returning neighbors up to a depth cap of 5.',
      inputSchema: {
        type: 'object',
        properties: {
          node_id: { type: 'string', description: 'Starting node ID' },
          depth: { type: 'number', description: 'Walk depth (max 5)' },
          edge_kinds: { type: 'array', items: { type: 'string' }, description: 'Edge kinds to traverse' },
          filters: { type: 'object', description: 'Optional filters' },
        },
        required: ['node_id'],
      },
    },
    {
      name: 'memtree_path_to_root',
      description: 'Walk the parent chain from a node to the root.',
      inputSchema: {
        type: 'object',
        properties: {
          node_id: { type: 'string', description: 'Node ID to trace' },
        },
        required: ['node_id'],
      },
    },
    {
      name: 'memtree_recent',
      description: 'Return the most recently created nodes, newest first.',
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'number', description: 'Unix timestamp lower bound' },
          limit: { type: 'number', description: 'Max results to return' },
          filters: { type: 'object', description: 'Optional filters' },
        },
      },
    },
    {
      name: 'memtree_read',
      description: 'Read a file with tree-sitter chunking and mtime caching.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative file path' },
          lines: {
            type: 'array',
            items: { type: 'number' },
            minItems: 2,
            maxItems: 2,
            description: '[start, end] line range (0-based)',
          },
          budget_tokens: { type: 'number', description: 'Token budget for chunking' },
        },
        required: ['path'],
      },
    },
    {
      name: 'memtree_grep',
      description: 'ripgrep integration — search file content by regex pattern.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search' },
          path: { type: 'string', description: 'Path to search within' },
          case_insensitive: { type: 'boolean', description: 'Case-insensitive search' },
          file_glob: { type: 'string', description: 'File glob filter' },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'memtree_compose',
      description: 'BFS graph expansion + scoring + budget-pack into a single context block.',
      inputSchema: {
        type: 'object',
        properties: {
          node_ids: { type: 'array', items: { type: 'string' }, description: 'Seed node IDs' },
          budget_tokens: { type: 'number', description: 'Token budget for output' },
          format: { type: 'string', enum: ['raw', 'outline'], description: 'Output format' },
          query: { type: 'string', description: 'Optional query for relevance scoring' },
          depth: { type: 'number', description: 'BFS expansion depth' },
        },
        required: ['node_ids', 'budget_tokens'],
      },
    },
    {
      name: 'memtree_note',
      description: 'Store a note or observation in the graph. Use to persist decisions, summaries, or any context you want retrievable in future sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Note content' },
          title:   { type: 'string', description: 'Optional short title (derived from first line if omitted)' },
        },
        required: ['content'],
      },
    },
    {
      name: 'memtree_monitor',
      description: 'Run a shell command, capture all output as a stored node, and return a compact reference. Use instead of Bash when the command produces large or streaming output — output stays out of context until you ask for it.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run' },
          timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default 30000)' },
          cwd: { type: 'string', description: 'Working directory (default: process cwd)' },
        },
        required: ['command'],
      },
    },
    {
      name: 'memtree_browse',
      description: 'Fetch a URL, extract structured text, store as a web_chunk node. Returns a compact reference with title, headings, and body excerpt.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'HTTP/HTTPS URL to fetch' },
          budget_tokens: { type: 'number', description: 'Token budget for body content' },
          force: { type: 'boolean', description: 'Bypass cache and re-fetch' },
        },
        required: ['url'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case 'memtree_search': {
        const { query, mode, limit, filters } = args as {
          query: string;
          mode?: string;
          limit?: number;
          filters?: Filters;
        };
        if (typeof query !== 'string') throw new McpError(ErrorCode.InvalidParams, '"query" is required and must be a string');
        if (mode !== undefined && mode !== 'keyword') {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Unsupported mode: "${mode}". Only "keyword" is supported.`,
          );
        }
        const result = searchKeyword(db, query, limit, filters);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }

      case 'memtree_neighbors': {
        const { node_id, depth, edge_kinds, filters } = args as {
          node_id: string;
          depth?: number;
          edge_kinds?: string[];
          filters?: Filters;
        };
        if (typeof node_id !== 'string') throw new McpError(ErrorCode.InvalidParams, '"node_id" is required and must be a string');
        const cap = Math.min(depth ?? 1, 5);
        const result = getNeighborsDeep(db, node_id, cap, edge_kinds as any, filters);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }

      case 'memtree_path_to_root': {
        const { node_id } = args as { node_id: string };
        if (typeof node_id !== 'string') throw new McpError(ErrorCode.InvalidParams, '"node_id" is required and must be a string');
        const result = getPathToRoot(db, node_id);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }

      case 'memtree_recent': {
        const { since, limit, filters } = args as {
          since?: number;
          limit?: number;
          filters?: Filters;
        };
        const result = getRecent(db, since, limit, filters);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }

      case 'memtree_read': {
        const { path, lines, budget_tokens } = args as {
          path: string;
          lines?: [number, number];
          budget_tokens?: number;
        };
        if (typeof path !== 'string') throw new McpError(ErrorCode.InvalidParams, '"path" is required and must be a string');
        const result = await memtreeRead(db, config, { path, lines, budget_tokens });
        return { content: [{ type: 'text', text: result.content }] };
      }

      case 'memtree_grep': {
        const { pattern, path, case_insensitive, file_glob } = args as {
          pattern: string;
          path?: string;
          case_insensitive?: boolean;
          file_glob?: string;
        };
        if (typeof pattern !== 'string') throw new McpError(ErrorCode.InvalidParams, '"pattern" is required and must be a string');
        const result = await memtreeGrep(db, config, {
          pattern,
          path,
          caseInsensitive: case_insensitive,
          fileGlob: file_glob,
        });
        return { content: [{ type: 'text', text: result.matches.join('\n') }] };
      }

      case 'memtree_compose': {
        const { node_ids, budget_tokens, format, query, depth } = args as {
          node_ids: string[];
          budget_tokens: number;
          format?: 'raw' | 'outline';
          query?: string;
          depth?: number;
        };
        if (!Array.isArray(node_ids)) throw new McpError(ErrorCode.InvalidParams, '"node_ids" is required and must be an array');
        if (typeof budget_tokens !== 'number') throw new McpError(ErrorCode.InvalidParams, '"budget_tokens" is required and must be a number');
        const result = await memtreeCompose(db, {
          node_ids,
          budget_tokens,
          format,
          query,
          depth,
        });
        return {
          content: [
            {
              type: 'text',
              text: result.content + '\n\n---\n' + JSON.stringify(result.manifest),
            },
          ],
        };
      }

      case 'memtree_note': {
        const { content, title } = args as { content: string; title?: string };
        const result = memtreeNote(db, config, { content, title });
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      }

      case 'memtree_monitor': {
        const { command, timeout_ms, cwd } = args as {
          command: string;
          timeout_ms?: number;
          cwd?: string;
        };
        const result = await memtreeMonitor(db, config, { command, timeout_ms, cwd });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                nodeId: result.nodeId,
                command: result.command,
                exit_code: result.exit_code,
                lines_captured: result.lines_captured,
                cached: result.cached,
                preview: result.preview,
                hint: `Full output stored as node ${result.nodeId}. Call memtree_compose(["${result.nodeId}"], 4000) to retrieve it within a token budget.`,
              }),
            },
          ],
        };
      }

      case 'memtree_browse': {
        const { url, budget_tokens, force } = args as {
          url: string;
          budget_tokens?: number;
          force?: boolean;
        };
        const result = await memtreeBrowse(db, config, { url, budget_tokens, force });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                nodeId: result.nodeId,
                url: result.url,
                title: result.title,
                description: result.description,
                headings: result.headings,
                cached: result.cached,
                truncated: result.truncated,
                content: result.content,
              }),
            },
          ],
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof McpError) throw err;
    throw new McpError(ErrorCode.InternalError, String(err));
  }
});

// ── Transport & lifecycle ─────────────────────────────────────────────────────
const transport = new StdioServerTransport();

function shutdown(): void {
  walkers.stop();
  closeDb(db);
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('disconnect', shutdown);

await server.connect(transport);
