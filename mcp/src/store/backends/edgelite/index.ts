import { openDb } from 'edgelite';
import type { Db } from 'edgelite';
import e from '../../../../dbschema/edgelite.js';
import type { StoreBackend, InsertNodeParams } from '../../interface.js';
import type { MemtreeNode, MemtreeEdge, NodeStatus, EdgeKind, Filters } from '../../types.js';
import { ulid } from 'ulid';

// Local interface for accessing the underlying PGlite instance.
// openDb() returns an InternalDb (not exported), but we know the shape.
interface PGliteHandle {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
interface DbWithPglite extends Db {
  pglite: PGliteHandle;
}

const NOT_IMPL = (name: string) =>
  new Error(
    `EdgeLite backend: ${name} is NotImplemented in Phase 7 — deferred to Phase 8`,
  );

export async function createEdgeliteBackend(
  dbPath: string,
  schemaPath: string,
): Promise<StoreBackend> {
  const db = await openDb(dbPath, schemaPath, { autoMigrate: true });
  return new EdgeliteBackend(db as DbWithPglite);
}

// Raw row shape returned by PGlite for nodes table.
interface NodeRow {
  id: string;
  parent_id: string | null;
  kind: string;
  source_uri: string | null;
  content: string;
  content_hash: string;
  status: string;
  mtime: number;
  created_at: number;
  updated_at: number;
  truncated: boolean;
  original_bytes: number | null;
  metadata: string | Record<string, unknown> | null;
  summary: string | null;
}

interface EdgeRow {
  src_id: string;
  dst_id: string;
  kind: string;
  created_at: number;
}

function toMemtreeNode(row: NodeRow): MemtreeNode {
  return {
    id: row.id,
    parent_id: row.parent_id ?? null,
    kind: row.kind as MemtreeNode['kind'],
    source_uri: row.source_uri ?? null,
    content: row.content,
    content_hash: row.content_hash,
    status: row.status as NodeStatus,
    mtime: Number(row.mtime),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    truncated: row.truncated ? 1 : 0,
    original_bytes: row.original_bytes ?? 0,
    metadata:
      typeof row.metadata === 'string'
        ? row.metadata
        : JSON.stringify(row.metadata ?? {}),
    summary: row.summary ?? null,
  };
}

function toMemtreeEdge(row: EdgeRow): MemtreeEdge {
  return {
    src_id: row.src_id,
    dst_id: row.dst_id,
    kind: row.kind as EdgeKind,
    created_at: Number(row.created_at),
  };
}

class EdgeliteBackend implements StoreBackend {
  constructor(private readonly db: DbWithPglite) {}

  // ── Core node CRUD ──────────────────────────────────────────────────────────

  async insertNode(id: string, params: InsertNodeParams): Promise<void> {
    const now = Date.now();
    const metadata =
      typeof params.metadata === 'string'
        ? params.metadata
        : JSON.stringify(params.metadata);

    // Use raw PGlite SQL because the edgelite insert builder always generates
    // its own id (gen_random_uuid()). We need to supply our own ULID.
    await this.db.pglite.query(
      `INSERT INTO nodes
         (id, parent_id, kind, source_uri, content, content_hash,
          status, mtime, created_at, updated_at, truncated, original_bytes, metadata, summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO NOTHING`,
      [
        id,
        params.parent_id,
        params.kind,
        params.source_uri ?? null,
        params.content,
        params.content_hash,
        params.status,
        params.mtime,
        now,
        now,
        params.truncated === 1,
        params.original_bytes,
        metadata,
        params.summary ?? null,
      ],
    );
  }

  async getNode(id: string): Promise<MemtreeNode | null> {
    const rows = await this.db.run<NodeRow[]>(
      e.select(e.Node, (n) => ({
        id: true,
        parent_id: true,
        kind: true,
        source_uri: true,
        content: true,
        content_hash: true,
        status: true,
        mtime: true,
        created_at: true,
        updated_at: true,
        truncated: true,
        original_bytes: true,
        metadata: true,
        summary: true,
        filter: e.op(n.id, '=', id),
        limit: 1,
      })),
    );
    return rows.length > 0 ? toMemtreeNode(rows[0]) : null;
  }

  async updateNodeStatus(id: string, status: NodeStatus): Promise<void> {
    await this.db.run(
      e.update(e.Node, (n) => ({
        filter: e.op(n.id, '=', id),
        set: { status, updated_at: Date.now() },
      })),
    );
  }

  async getNodeBySourceUri(uri: string): Promise<MemtreeNode | null> {
    const rows = await this.db.run<NodeRow[]>(
      e.select(e.Node, (n) => ({
        id: true,
        parent_id: true,
        kind: true,
        source_uri: true,
        content: true,
        content_hash: true,
        status: true,
        mtime: true,
        created_at: true,
        updated_at: true,
        truncated: true,
        original_bytes: true,
        metadata: true,
        summary: true,
        filter: e.all(
          e.op(n.source_uri, '=', uri),
          e.op(n.status, '=', 'live'),
        ),
        orderBy: { expr: n.created_at, dir: 'DESC' },
        limit: 1,
      })),
    );
    return rows.length > 0 ? toMemtreeNode(rows[0]) : null;
  }

  async getNodeByContentHash(hash: string): Promise<MemtreeNode | null> {
    const rows = await this.db.run<NodeRow[]>(
      e.select(e.Node, (n) => ({
        id: true,
        parent_id: true,
        kind: true,
        source_uri: true,
        content: true,
        content_hash: true,
        status: true,
        mtime: true,
        created_at: true,
        updated_at: true,
        truncated: true,
        original_bytes: true,
        metadata: true,
        summary: true,
        filter: e.all(
          e.op(n.content_hash, '=', hash),
          e.op(n.status, '=', 'live'),
        ),
        limit: 1,
      })),
    );
    return rows.length > 0 ? toMemtreeNode(rows[0]) : null;
  }

  async listChildren(parentId: string, status: NodeStatus = 'live'): Promise<MemtreeNode[]> {
    const rows = await this.db.run<NodeRow[]>(
      e.select(e.Node, (n) => ({
        id: true,
        parent_id: true,
        kind: true,
        source_uri: true,
        content: true,
        content_hash: true,
        status: true,
        mtime: true,
        created_at: true,
        updated_at: true,
        truncated: true,
        original_bytes: true,
        metadata: true,
        summary: true,
        filter: e.all(
          e.op(n.parent_id, '=', parentId),
          e.op(n.status, '=', status),
        ),
        orderBy: { expr: n.created_at, dir: 'ASC' },
      })),
    );
    return rows.map(toMemtreeNode);
  }

  async getOrCreateSessionNode(sessionId: string): Promise<MemtreeNode> {
    // session_id is stored inside the metadata JSON — not a direct column.
    // Fetch all session nodes and filter in JS.
    const rows = await this.db.run<NodeRow[]>(
      e.select(e.Node, (n) => ({
        id: true,
        parent_id: true,
        kind: true,
        source_uri: true,
        content: true,
        content_hash: true,
        status: true,
        mtime: true,
        created_at: true,
        updated_at: true,
        truncated: true,
        original_bytes: true,
        metadata: true,
        summary: true,
        filter: e.op(n.kind, '=', 'session'),
      })),
    );

    for (const row of rows) {
      let meta: Record<string, unknown> = {};
      try {
        if (typeof row.metadata === 'string') {
          meta = JSON.parse(row.metadata);
        } else if (row.metadata != null) {
          meta = row.metadata as Record<string, unknown>;
        }
      } catch {
        /* ignore parse errors */
      }
      if (meta.session_id === sessionId) {
        return toMemtreeNode(row);
      }
    }

    // Not found — create a new session node.
    const id = ulid();
    await this.insertNode(id, {
      parent_id: null,
      kind: 'session',
      source_uri: null,
      content: '',
      content_hash: '',
      status: 'live',
      mtime: 0,
      truncated: 0,
      original_bytes: 0,
      metadata: JSON.stringify({ session_id: sessionId }),
    });
    return (await this.getNode(id))!;
  }

  async markStaleByFilePath(filePath: string, mtime: number): Promise<void> {
    // filePath is stored in metadata JSON — not a direct column.
    // Fetch all live file_chunk nodes and filter in JS, then update each.
    const rows = await this.db.run<NodeRow[]>(
      e.select(e.Node, (n) => ({
        id: true,
        mtime: true,
        metadata: true,
        filter: e.all(
          e.op(n.kind, '=', 'file_chunk'),
          e.op(n.status, '=', 'live'),
        ),
      })),
    );

    const now = Date.now();
    for (const row of rows) {
      let meta: Record<string, unknown> = {};
      try {
        if (typeof row.metadata === 'string') {
          meta = JSON.parse(row.metadata);
        } else if (row.metadata != null) {
          meta = row.metadata as Record<string, unknown>;
        }
      } catch {
        /* ignore */
      }
      if (meta.filePath === filePath && Number(row.mtime) !== mtime) {
        await this.db.run(
          e.update(e.Node, (n) => ({
            filter: e.op(n.id, '=', row.id),
            set: { status: 'stale', updated_at: now },
          })),
        );
      }
    }
  }

  async countPendingNodes(): Promise<number> {
    return this.db.run<number>(
      e.count(e.Node, (n) => ({
        filter: e.op(n.status, '=', 'pending'),
      })),
    );
  }

  async getPendingNodes(limit = 100): Promise<MemtreeNode[]> {
    const rows = await this.db.run<NodeRow[]>(
      e.select(e.Node, (n) => ({
        id: true,
        parent_id: true,
        kind: true,
        source_uri: true,
        content: true,
        content_hash: true,
        status: true,
        mtime: true,
        created_at: true,
        updated_at: true,
        truncated: true,
        original_bytes: true,
        metadata: true,
        summary: true,
        filter: e.op(n.status, '=', 'pending'),
        orderBy: { expr: n.created_at, dir: 'ASC' },
        limit,
      })),
    );
    return rows.map(toMemtreeNode);
  }

  async getLiveFileChunks(cutoffMs: number): Promise<MemtreeNode[]> {
    // Filter: kind='file_chunk' AND status='live' AND mtime>0 AND updated_at < cutoffMs
    // The e.op builder only supports a fixed set of operators including '<'.
    // Use raw SQL to handle the composite filter cleanly.
    const result = await this.db.pglite.query<NodeRow>(
      `SELECT * FROM nodes
       WHERE kind = 'file_chunk'
         AND status = 'live'
         AND mtime > 0
         AND updated_at < $1`,
      [cutoffMs],
    );
    return result.rows.map(toMemtreeNode);
  }

  async getStaleNodes(olderThanMs: number): Promise<MemtreeNode[]> {
    const result = await this.db.pglite.query<NodeRow>(
      `SELECT * FROM nodes WHERE status = 'stale' AND updated_at < $1`,
      [olderThanMs],
    );
    return result.rows.map(toMemtreeNode);
  }

  async getSupersededNodes(olderThanMs: number): Promise<MemtreeNode[]> {
    const result = await this.db.pglite.query<NodeRow>(
      `SELECT * FROM nodes WHERE status = 'superseded' AND updated_at < $1`,
      [olderThanMs],
    );
    return result.rows.map(toMemtreeNode);
  }

  async pruneNode(id: string): Promise<void> {
    await this.db.run(
      e.update(e.Node, (n) => ({
        filter: e.op(n.id, '=', id),
        set: { status: 'pruned', content: '', updated_at: Date.now() },
      })),
    );
  }

  async updateNodeSummary(id: string, summary: string): Promise<void> {
    await this.db.run(
      e.update(e.Node, (n) => ({
        filter: e.op(n.id, '=', id),
        set: { summary, updated_at: Date.now() },
      })),
    );
  }

  // ── Edge CRUD ───────────────────────────────────────────────────────────────

  async insertEdge(edge: Omit<MemtreeEdge, 'created_at'>): Promise<void> {
    await this.db.run(
      e.insert(e.Edge, {
        src_id: edge.src_id,
        dst_id: edge.dst_id,
        kind: edge.kind,
        created_at: Date.now(),
      }).unlessConflict(),
    );
  }

  async getNeighbors(nodeId: string, edgeKinds?: EdgeKind[]): Promise<MemtreeNode[]> {
    if (edgeKinds && edgeKinds.length > 0) {
      // Use the typed neighbors builder — it filters by edge kind via ANY($2::text[]).
      const rows = await this.db.run<NodeRow[]>(
        e.neighbors(nodeId, { edgeKinds }),
      );
      return rows.map(toMemtreeNode);
    }

    // No edge-kind filter: return all live neighbors regardless of edge kind.
    const result = await this.db.pglite.query<NodeRow>(
      `SELECT DISTINCT n.* FROM nodes n
       JOIN edges e
         ON (e.src_id = $1 AND e.dst_id = n.id)
         OR (e.dst_id = $1 AND e.src_id = n.id)
       WHERE n.status = 'live'`,
      [nodeId],
    );
    return result.rows.map(toMemtreeNode);
  }

  async getEdgesFrom(srcId: string): Promise<MemtreeEdge[]> {
    const rows = await this.db.run<EdgeRow[]>(
      e.select(e.Edge, (edge) => ({
        src_id: true,
        dst_id: true,
        kind: true,
        created_at: true,
        filter: e.op(edge.src_id, '=', srcId),
      })),
    );
    return rows.map(toMemtreeEdge);
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  async searchKeyword(
    query: string,
    _filters: Filters = {},
    limit = 20,
  ): Promise<MemtreeNode[]> {
    if (!query.trim()) return [];
    try {
      const rows = await this.db.run<NodeRow[]>(
        e.fts(e.Node, query),
      );
      return rows.slice(0, limit).map(toMemtreeNode);
    } catch {
      return [];
    }
  }

  async searchSemantic(
    _vector: number[],
    _embeddingModel: string,
    _filters: Filters = {},
    _limit = 20,
  ): Promise<MemtreeNode[]> {
    throw NOT_IMPL('searchSemantic');
  }

  // ── Complex graph / tool queries (Phase 8) ──────────────────────────────────

  async getNodesByIds(_ids: string[]): Promise<MemtreeNode[]> {
    throw NOT_IMPL('getNodesByIds');
  }

  async getRecentNodes(
    _since?: number,
    _limit?: number,
    _filters?: Filters,
  ): Promise<MemtreeNode[]> {
    throw NOT_IMPL('getRecentNodes');
  }

  async getPathToRoot(_nodeId: string): Promise<MemtreeNode[]> {
    throw NOT_IMPL('getPathToRoot');
  }

  async getNeighborsDeep(
    _nodeId: string,
    _depth?: number,
    _edgeKinds?: EdgeKind[],
    _filters?: Filters,
  ): Promise<MemtreeNode[]> {
    throw NOT_IMPL('getNeighborsDeep');
  }

  async expandGraph(_seedIds: string[], _maxDepth: number): Promise<Map<string, number>> {
    throw NOT_IMPL('expandGraph');
  }

  async getFtsRanks(_query: string, _ids: string[]): Promise<Map<string, number>> {
    throw NOT_IMPL('getFtsRanks');
  }

  // ── Vector / embedding (Phase 8) ────────────────────────────────────────────

  async getPendingEmbeddingNodes(
    _batchSize: number,
  ): Promise<Array<{ id: string; content: string }>> {
    throw NOT_IMPL('getPendingEmbeddingNodes');
  }

  async batchUpsertNodeVec(
    _rows: Array<{
      id: string;
      embedding: Buffer;
      model: string;
      dim: number;
      embeddedAt: number;
    }>,
  ): Promise<void> {
    throw NOT_IMPL('batchUpsertNodeVec');
  }

  async getStoredEmbeddingModels(): Promise<string[]> {
    throw NOT_IMPL('getStoredEmbeddingModels');
  }

  // ── Dedupe walker (Phase 8) ─────────────────────────────────────────────────

  async getDedupeCandidatePairs(): Promise<
    Array<{
      id1: string;
      id2: string;
      emb1: Uint8Array;
      emb2: Uint8Array;
      ts1: number;
      ts2: number;
    }>
  > {
    throw NOT_IMPL('getDedupeCandidatePairs');
  }

  async markNodeStatusPruned(_id: string, _now: number): Promise<void> {
    throw NOT_IMPL('markNodeStatusPruned');
  }

  // ── Summarizer walker (Phase 8) ─────────────────────────────────────────────

  async getNodesNeedingSummarization(
    _charThreshold: number,
    _limit: number,
  ): Promise<Array<{ id: string; content: string; source_uri: string | null }>> {
    throw NOT_IMPL('getNodesNeedingSummarization');
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    await this.db.close();
  }
}
