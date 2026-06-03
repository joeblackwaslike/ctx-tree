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

  // ── Visualization helpers ────────────────────────────────────────────────────

  async getNodesSince(since: number): Promise<MemtreeNode[]> {
    const rows = await this.db.pglite.query<NodeRow>(
      'SELECT * FROM nodes WHERE updated_at >= $1',
      [since],
    );
    return rows.rows.map(toMemtreeNode);
  }

  async getAllEdges(): Promise<MemtreeEdge[]> {
    const rows = await this.db.run<EdgeRow[]>(
      e.select(e.Edge, (edge) => ({
        src_id: true,
        dst_id: true,
        kind: true,
        created_at: true,
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
    vector: number[],
    embeddingModel: string,
    filters: Filters = {},
    limit = 20,
  ): Promise<MemtreeNode[]> {
    const vecStr = '[' + vector.join(',') + ']';
    const normalizedModel = embeddingModel.replace(/^[^/]+\//, '');

    const conditions: string[] = [`v.embedding_model = $2`];
    const params: unknown[] = [vecStr, normalizedModel];
    let idx = 3;

    const statuses = filters.status?.length ? filters.status : ['live'];
    conditions.push(`n.status = ANY($${idx++}::text[])`);
    params.push(statuses);

    if (filters.kind?.length) {
      conditions.push(`n.kind = ANY($${idx++}::text[])`);
      params.push(filters.kind);
    }
    if (filters.since != null) {
      conditions.push(`n.created_at >= $${idx++}`);
      params.push(filters.since);
    }
    if (filters.until != null) {
      conditions.push(`n.created_at <= $${idx++}`);
      params.push(filters.until);
    }
    if (filters.parent_id != null) {
      conditions.push(`n.parent_id = $${idx++}`);
      params.push(filters.parent_id);
    }
    if (filters.session_id != null) {
      conditions.push(`n.metadata->>'session_id' = $${idx++}`);
      params.push(filters.session_id);
    }
    if (filters.metadata?.tool != null) {
      conditions.push(`n.metadata->>'tool' = $${idx++}`);
      params.push(filters.metadata.tool);
    }
    if (filters.metadata?.session_id != null) {
      conditions.push(`n.metadata->>'session_id' = $${idx++}`);
      params.push(filters.metadata.session_id);
    }

    params.push(limit);
    const result = await this.db.pglite.query<NodeRow>(
      `SELECT n.* FROM nodes n
       JOIN nodes_vec v ON n.id = v.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY v.embedding <=> $1::vector
       LIMIT $${idx}`,
      params,
    );
    return result.rows.map(toMemtreeNode);
  }

  // ── Complex graph / tool queries ───────────────────────────────────────────

  async getNodesByIds(ids: string[]): Promise<MemtreeNode[]> {
    if (ids.length === 0) return [];
    const CHUNK = 500;
    const result: MemtreeNode[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const rows = await this.db.pglite.query<NodeRow>(
        `SELECT * FROM nodes WHERE id = ANY($1::text[]) AND status = 'live'`,
        [chunk],
      );
      result.push(...rows.rows.map(toMemtreeNode));
    }
    return result;
  }

  async getRecentNodes(
    since?: number,
    limit = 50,
    filters: Filters = {},
  ): Promise<MemtreeNode[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (since != null) {
      conditions.push(`created_at >= $${idx++}`);
      params.push(since);
    }
    if (filters.status) {
      conditions.push(`status = $${idx++}`);
      params.push(filters.status);
    }
    if (filters.kind) {
      conditions.push(`kind = $${idx++}`);
      params.push(filters.kind);
    }
    if (filters.until != null) {
      conditions.push(`created_at <= $${idx++}`);
      params.push(filters.until);
    }
    if (filters.parent_id != null) {
      conditions.push(`parent_id = $${idx++}`);
      params.push(filters.parent_id);
    }

    const where = conditions.length > 0 ? conditions.join(' AND ') : 'TRUE';
    params.push(limit);

    const rows = await this.db.pglite.query<NodeRow>(
      `SELECT * FROM nodes WHERE ${where} ORDER BY created_at DESC LIMIT $${idx}`,
      params,
    );
    return rows.rows.map(toMemtreeNode);
  }

  async getPathToRoot(nodeId: string): Promise<MemtreeNode[]> {
    const path: MemtreeNode[] = [];
    let currentId: string | null = nodeId;
    while (currentId != null) {
      const result = await this.db.pglite.query<NodeRow>(
        'SELECT * FROM nodes WHERE id = $1',
        [currentId],
      );
      if (result.rows.length === 0) break;
      const row = result.rows[0];
      path.push(toMemtreeNode(row));
      currentId = row.parent_id ?? null;
    }
    return path;
  }

  async getNeighborsDeep(
    nodeId: string,
    depth = 1,
    edgeKinds?: EdgeKind[],
    filters: Filters = {},
  ): Promise<MemtreeNode[]> {
    const cap = Math.min(depth, 5);
    const visited = new Set<string>([nodeId]);
    const result: MemtreeNode[] = [];
    let frontier = [nodeId];

    for (let d = 0; d < cap; d++) {
      if (frontier.length === 0) break;
      const nextNodes: MemtreeNode[] = [];

      for (const fId of frontier) {
        let rows: NodeRow[];
        if (edgeKinds && edgeKinds.length > 0) {
          rows = await this.db.run<NodeRow[]>(e.neighbors(fId, { edgeKinds }));
        } else {
          const res = await this.db.pglite.query<NodeRow>(
            `SELECT DISTINCT n.* FROM nodes n
             JOIN edges e
               ON (e.src_id = $1 AND e.dst_id = n.id)
               OR (e.dst_id = $1 AND e.src_id = n.id)`,
            [fId],
          );
          rows = res.rows;
        }
        for (const row of rows) {
          if (!visited.has(row.id)) nextNodes.push(toMemtreeNode(row));
        }
      }

      const fresh = nextNodes.filter(n => {
        if (visited.has(n.id)) return false;
        if (filters.kind && n.kind !== filters.kind) return false;
        if (filters.status && n.status !== filters.status) return false;
        if (filters.since != null && n.created_at < filters.since) return false;
        if (filters.until != null && n.created_at > filters.until) return false;
        if (filters.parent_id != null && n.parent_id !== filters.parent_id) return false;
        return true;
      });

      for (const n of fresh) {
        visited.add(n.id);
        result.push(n);
      }
      frontier = fresh.map(n => n.id);
    }

    return result;
  }

  async expandGraph(seedIds: string[], maxDepth: number): Promise<Map<string, number>> {
    const visited = new Map<string, number>();
    const queue: [string, number][] = seedIds.map(id => [id, 0]);

    while (queue.length > 0) {
      const [id, dist] = queue.shift()!;
      if (visited.has(id)) continue;
      visited.set(id, dist);
      if (dist >= maxDepth) continue;

      const childRows = await this.db.pglite.query<{ id: string }>(
        `SELECT id FROM nodes WHERE parent_id = $1 AND status = 'live'`,
        [id],
      );
      const neighborRows = await this.db.run<NodeRow[]>(e.neighbors(id, {}));

      const nextIds = [
        ...childRows.rows.map(r => r.id),
        ...neighborRows.map(r => r.id),
      ];
      for (const nextId of nextIds) {
        if (!visited.has(nextId)) queue.push([nextId, dist + 1]);
      }
    }

    return visited;
  }

  async getFtsRanks(query: string, ids: string[]): Promise<Map<string, number>> {
    if (!query.trim() || ids.length === 0) return new Map();
    try {
      const rows = await this.db.run<NodeRow[]>(e.fts(e.Node, query));
      const idSet = new Set(ids);
      const matched = rows.filter(r => idSet.has(r.id)).map(r => r.id);
      if (matched.length === 0) return new Map();
      return new Map(matched.map(id => [id, 1.0]));
    } catch {
      return new Map();
    }
  }

  // ── Vector / embedding ───────────────────────────────────────────────────────

  async getPendingEmbeddingNodes(
    batchSize: number,
  ): Promise<Array<{ id: string; content: string }>> {
    const result = await this.db.pglite.query<{ id: string; content: string }>(
      `SELECT n.id, n.content FROM nodes n
       LEFT JOIN nodes_vec v ON n.id = v.id
       WHERE n.status = 'live'
         AND v.id IS NULL
         AND length(n.content) > 0
       LIMIT $1`,
      [batchSize],
    );
    return result.rows;
  }

  async batchUpsertNodeVec(
    rows: Array<{
      id: string;
      embedding: Buffer;
      model: string;
      dim: number;
      embeddedAt: number;
    }>,
  ): Promise<void> {
    for (const row of rows) {
      const floats = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      const vecStr = '[' + Array.from(floats).join(',') + ']';
      await this.db.pglite.query(
        `INSERT INTO nodes_vec (id, embedding, embedding_model, embedding_dim, embedded_at)
         VALUES ($1, $2::vector, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           embedding = EXCLUDED.embedding,
           embedding_model = EXCLUDED.embedding_model,
           embedding_dim = EXCLUDED.embedding_dim,
           embedded_at = EXCLUDED.embedded_at`,
        [row.id, vecStr, row.model, row.dim, row.embeddedAt],
      );
    }
  }

  async getStoredEmbeddingModels(): Promise<string[]> {
    const result = await this.db.pglite.query<{ embedding_model: string }>(
      'SELECT DISTINCT embedding_model FROM nodes_vec LIMIT 2',
    );
    return result.rows.map(r => r.embedding_model);
  }

  // ── Dedupe walker ────────────────────────────────────────────────────────────

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
    return [];
  }

  async markNodeStatusPruned(id: string, _now: number): Promise<void> {
    return this.pruneNode(id);
  }

  // ── Summarizer walker ────────────────────────────────────────────────────────

  async getNodesNeedingSummarization(
    charThreshold: number,
    limit: number,
  ): Promise<Array<{ id: string; content: string; source_uri: string | null }>> {
    const rows = await this.db.pglite.query<{
      id: string;
      content: string;
      source_uri: string | null;
    }>(
      `SELECT id, content, source_uri FROM nodes
       WHERE status = 'live'
         AND (summary IS NULL OR summary = '')
         AND length(content) > $1
       LIMIT $2`,
      [charThreshold, limit],
    );
    return rows.rows;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    await this.db.close();
  }
}
