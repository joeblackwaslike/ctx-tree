import type { Database } from 'bun:sqlite';
// Embed the visualizer UI at build time so `bun build --compile` bakes it into the
// standalone binary — at runtime there is no ui.html sitting next to the entrypoint.
import uiHtml from './ui.html' with { type: 'text' };
import type { CtxTreeNode, CtxTreeEdge } from '../store/types.js';
import { DbWatcher } from './watcher.js';

const VALID_STATUSES = new Set(['pending', 'live', 'stale', 'superseded', 'pruned']);
const VALID_KINDS = new Set([
  'session', 'file_chunk', 'tool_output', 'summary', 'note',
  'observation', 'web_chunk', 'prompt', 'thinking', 'response',
]);

export interface VisualizeServerOptions {
  port?: number;
  host?: string;
}

export class VisualizeServer {
  private httpServer: ReturnType<typeof Bun.serve> | null = null;
  private watcher: DbWatcher;
  private unsubscribe: (() => void) | null = null;
  private clients = new Set<import('bun').ServerWebSocket<unknown>>();
  private ui: string;
  private started = false;

  readonly host: string;
  port: number;

  constructor(private db: Database, options: VisualizeServerOptions = {}) {
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 7777;
    this.watcher = new DbWatcher(db);
    this.ui = uiHtml;
  }

  async start(): Promise<{ url: string; port: number }> {
    if (this.started) return { url: this.url, port: this.port };

    const effectivePort = this.port === 0 ? 0 : await findFreePort(this.port);
    const self = this;

    this.httpServer = Bun.serve({
      hostname: this.host,
      port: effectivePort,
      fetch(req, server) {
        const url = new URL(req.url);

        if (url.pathname === '/api/events') {
          if (server.upgrade(req)) return undefined as unknown as Response;
          return new Response('WebSocket upgrade failed', { status: 400 });
        }
        if (url.pathname === '/' || url.pathname === '') {
          return new Response(self.ui, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }
        if (url.pathname === '/api/state') {
          const { nodes, edges } = self.snapshot(url.searchParams);
          return Response.json({ nodes, edges });
        }
        if (url.pathname.startsWith('/api/node/')) {
          const id = url.pathname.slice('/api/node/'.length);
          const node = self.db
            .query<CtxTreeNode, [string]>('SELECT * FROM nodes WHERE id = ?')
            .get(id);
          return node
            ? Response.json(node)
            : new Response('Not found', { status: 404 });
        }
        if (url.pathname === '/health') {
          return Response.json(self.stats());
        }
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open(ws) {
          self.clients.add(ws);
          const { nodes, edges } = self.snapshot(new URLSearchParams());
          ws.send(JSON.stringify({ op: 'snapshot', nodes, edges }));
        },
        message() {},
        close(ws) {
          self.clients.delete(ws);
        },
      },
    });

    this.port = this.httpServer.port;

    this.unsubscribe = this.watcher.on(event => {
      const msg = JSON.stringify(event);
      for (const ws of this.clients) {
        try { ws.send(msg); } catch { /* client disconnected */ }
      }
    });

    this.started = true;
    return { url: this.url, port: this.port };
  }

  get url(): string {
    return `http://${this.host}:${this.port}`;
  }

  stats(): { status: 'ok'; nodeCount: number; edgeCount: number } {
    const nodeCount =
      (this.db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM nodes').get())?.count ?? 0;
    const edgeCount =
      (this.db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM edges').get())?.count ?? 0;
    return { status: 'ok', nodeCount, edgeCount };
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.httpServer?.stop(true);
    this.httpServer = null;
    this.clients.clear();
    this.started = false;
  }

  private snapshot(params: URLSearchParams): { nodes: CtxTreeNode[]; edges: CtxTreeEdge[] } {
    const conditions: string[] = [];
    const args: (string | number)[] = [];

    const rawKinds = (params.get('kind') ?? '').split(',').filter(k => VALID_KINDS.has(k));
    if (rawKinds.length) {
      conditions.push(`kind IN (${rawKinds.map(() => '?').join(',')})`);
      args.push(...rawKinds);
    }

    const rawStatuses = (params.get('status') ?? '').split(',').filter(s => VALID_STATUSES.has(s));
    if (rawStatuses.length) {
      conditions.push(`status IN (${rawStatuses.map(() => '?').join(',')})`);
      args.push(...rawStatuses);
    } else {
      conditions.push(`status != 'pruned'`);
    }

    const sessionId = params.get('session_id');
    if (sessionId) {
      conditions.push(`json_extract(metadata, '$.session_id') = ?`);
      args.push(sessionId);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const nodes = this.db
      .query<CtxTreeNode, typeof args>(`SELECT * FROM nodes ${where}`)
      .all(...args);
    const edges = this.db
      .query<CtxTreeEdge, []>('SELECT * FROM edges')
      .all();

    return { nodes, edges };
  }
}

async function findFreePort(start: number): Promise<number> {
  for (let p = start; p < start + 10; p++) {
    try {
      const s = Bun.serve({ port: p, hostname: '127.0.0.1', fetch: () => new Response('') });
      const assignedPort = s.port;
      s.stop(true);
      return assignedPort;
    } catch {
      continue;
    }
  }
  throw new Error(`No free port found in range ${start}–${start + 9}`);
}
