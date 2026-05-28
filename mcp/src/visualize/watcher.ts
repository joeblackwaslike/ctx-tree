// mcp/src/visualize/watcher.ts
import type { Database } from 'bun:sqlite';
import type { MemtreeNode, MemtreeEdge } from '../store/types.js';

export type ChangeEvent =
  | { op: 'insert' | 'update'; table: 'nodes'; id: string; data: MemtreeNode }
  | { op: 'delete'; table: 'nodes'; id: string }
  | { op: 'insert'; table: 'edges'; id: string; data: MemtreeEdge }
  | { op: 'delete'; table: 'edges'; id: string };

export type ChangeListener = (event: ChangeEvent) => void;

export class DbWatcher {
  private readonly listeners = new Set<ChangeListener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastMs = 0;
  private readonly knownNodeIds = new Set<string>();
  private readonly knownEdgeIds = new Set<string>();

  private readonly nodesSince: ReturnType<Database['query']>;
  private readonly edgesSince: ReturnType<Database['query']>;

  constructor(private readonly db: Database, private readonly intervalMs = 200) {
    this.nodesSince = db.query<MemtreeNode, [number]>(
      'SELECT * FROM nodes WHERE updated_at >= ?'
    );
    this.edgesSince = db.query<MemtreeEdge, [number]>(
      'SELECT * FROM edges WHERE created_at >= ?'
    );
  }

  start(): void {
    if (this.timer) return;
    // seed known IDs so first poll doesn't emit everything as new
    this.lastMs = Date.now();
    for (const n of this.db.query<{ id: string }, []>('SELECT id FROM nodes').all()) {
      this.knownNodeIds.add(n.id);
    }
    for (const e of this.db.query<{ src_id: string; dst_id: string; kind: string }, []>(
      'SELECT src_id, dst_id, kind FROM edges'
    ).all()) {
      this.knownEdgeIds.add(`${e.src_id}:${e.dst_id}:${e.kind}`);
    }
    this.timer = setInterval(() => this._poll(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  on(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    if (!this.timer) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  private _poll(): void {
    if (this.listeners.size === 0) return;

    const since = this.lastMs;
    this.lastMs = Date.now();

    // Nodes changed since last poll
    const changedNodes = this.nodesSince.all(since) as MemtreeNode[];
    for (const node of changedNodes) {
      const op = this.knownNodeIds.has(node.id) ? 'update' : 'insert';
      this.knownNodeIds.add(node.id);
      this.emit({ op, table: 'nodes', id: node.id, data: node });
    }

    // Edges created since last poll (edges are never updated, only inserted or cascade-deleted)
    const newEdges = this.edgesSince.all(since) as MemtreeEdge[];
    for (const edge of newEdges) {
      const compositeId = `${edge.src_id}:${edge.dst_id}:${edge.kind}`;
      if (!this.knownEdgeIds.has(compositeId)) {
        this.knownEdgeIds.add(compositeId);
        this.emit({ op: 'insert', table: 'edges', id: compositeId, data: edge });
      }
    }

    // Deletions: nodes whose status is now 'pruned' or that are missing entirely
    // In practice memtree rarely hard-deletes nodes — pruned nodes get status='pruned'
    // Emit 'update' for status changes (covered above). True hard-deletes are rare
    // and will be caught on the next full snapshot (WebSocket reconnect).
  }

  private emit(event: ChangeEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* never let listener errors break the poller */ }
    }
  }
}
