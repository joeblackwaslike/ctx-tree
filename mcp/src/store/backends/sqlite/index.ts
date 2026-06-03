import { Database } from 'bun:sqlite';
import { openDb, closeDb } from '../../db.js';
import {
  insertNode as sqlInsertNode,
  getNode as sqlGetNode,
  updateNodeStatus as sqlUpdateNodeStatus,
  getNodeBySourceUri as sqlGetNodeBySourceUri,
  getNodeByContentHash as sqlGetNodeByContentHash,
  listChildren as sqlListChildren,
  getOrCreateSessionNode as sqlGetOrCreateSessionNode,
  markStaleByFilePath as sqlMarkStaleByFilePath,
  countPendingNodes as sqlCountPendingNodes,
  getPendingNodes as sqlGetPendingNodes,
  getLiveFileChunks as sqlGetLiveFileChunks,
  getStaleNodes as sqlGetStaleNodes,
  getSupersededNodes as sqlGetSupersededNodes,
  pruneNode as sqlPruneNode,
} from '../../nodes.js';
import {
  insertEdge as sqlInsertEdge,
  getNeighbors as sqlGetNeighbors,
  getEdgesFrom as sqlGetEdgesFrom,
} from '../../edges.js';
import { buildFilterSQL } from '../../../tools/filters.js';
import type { StoreBackend, InsertNodeParams } from '../../interface.js';
import type { MemtreeNode, MemtreeEdge, NodeStatus, EdgeKind, Filters } from '../../types.js';

// Cache verified embedding model per Database instance for searchSemantic.
const embeddingModelCache = new WeakMap<Database, string>();

export async function createSqliteBackend(dbPath: string): Promise<StoreBackend> {
  const db = openDb(dbPath);
  return new SqliteBackend(db);
}

/**
 * Wrap an existing bun:sqlite Database in a StoreBackend adapter.
 * Useful in tests that construct a Database directly (e.g. openDb(':memory:')).
 * The caller is responsible for closing the underlying db.
 */
export function wrapDatabase(db: Database): StoreBackend {
  return new SqliteBackend(db);
}

class SqliteBackend implements StoreBackend {
  constructor(private readonly db: Database) {}

  // ── Core node CRUD ─────────────────────────────────────────────────────────

  async insertNode(id: string, params: InsertNodeParams): Promise<void> {
    sqlInsertNode(this.db, id, params);
  }

  async getNode(id: string): Promise<MemtreeNode | null> {
    return sqlGetNode(this.db, id);
  }

  async updateNodeStatus(id: string, status: NodeStatus): Promise<void> {
    sqlUpdateNodeStatus(this.db, id, status);
  }

  async getNodeBySourceUri(uri: string): Promise<MemtreeNode | null> {
    return sqlGetNodeBySourceUri(this.db, uri);
  }

  async getNodeByContentHash(hash: string): Promise<MemtreeNode | null> {
    return sqlGetNodeByContentHash(this.db, hash);
  }

  async listChildren(parentId: string, status: NodeStatus = 'live'): Promise<MemtreeNode[]> {
    return sqlListChildren(this.db, parentId, status);
  }

  async getOrCreateSessionNode(sessionId: string): Promise<MemtreeNode> {
    return sqlGetOrCreateSessionNode(this.db, sessionId);
  }

  async markStaleByFilePath(filePath: string, mtime: number): Promise<void> {
    sqlMarkStaleByFilePath(this.db, filePath, mtime);
  }

  async countPendingNodes(): Promise<number> {
    return sqlCountPendingNodes(this.db);
  }

  async getPendingNodes(limit = 100): Promise<MemtreeNode[]> {
    return sqlGetPendingNodes(this.db, limit);
  }

  async getLiveFileChunks(cutoffMs: number): Promise<MemtreeNode[]> {
    return sqlGetLiveFileChunks(this.db, cutoffMs);
  }

  async getStaleNodes(olderThanMs: number): Promise<MemtreeNode[]> {
    return sqlGetStaleNodes(this.db, olderThanMs);
  }

  async getSupersededNodes(olderThanMs: number): Promise<MemtreeNode[]> {
    return sqlGetSupersededNodes(this.db, olderThanMs);
  }

  async pruneNode(id: string): Promise<void> {
    sqlPruneNode(this.db, id);
  }

  async updateNodeSummary(id: string, summary: string): Promise<void> {
    this.db.run('UPDATE nodes SET summary = ?, updated_at = ? WHERE id = ?', summary, Date.now(), id);
  }

  // ── Edge CRUD ──────────────────────────────────────────────────────────────

  async insertEdge(edge: Omit<MemtreeEdge, 'created_at'>): Promise<void> {
    sqlInsertEdge(this.db, edge);
  }

  async getNeighbors(nodeId: string, edgeKinds?: EdgeKind[]): Promise<MemtreeNode[]> {
    return sqlGetNeighbors(this.db, nodeId, edgeKinds);
  }

  async getEdgesFrom(srcId: string): Promise<MemtreeEdge[]> {
    return sqlGetEdgesFrom(this.db, srcId);
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  async searchKeyword(query: string, filters: Filters = {}, limit = 20): Promise<MemtreeNode[]> {
    if (!query.trim()) return [];
    const { where, params } = buildFilterSQL(filters);
    try {
      return this.db.query(`
        SELECT n.* FROM nodes n
        JOIN nodes_fts f ON f.id = n.id
        WHERE nodes_fts MATCH ? AND ${where}
        ORDER BY bm25(nodes_fts)
        LIMIT ?
      `).all(query, ...params, limit) as MemtreeNode[];
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
    const normalizedModel = embeddingModel.replace(/^[^/]+\//, '');
    const cached = embeddingModelCache.get(this.db);
    if (cached !== normalizedModel) {
      const stored = this.db.prepare(
        'SELECT DISTINCT embedding_model FROM nodes_vec LIMIT 2'
      ).all() as { embedding_model: string }[];
      if (
        stored.length > 1 ||
        (stored[0] && stored[0].embedding_model !== normalizedModel)
      ) {
        throw new Error('embedding model mismatch: re-embed required before semantic search');
      }
      embeddingModelCache.set(this.db, normalizedModel);
    }

    const { where, params } = buildFilterSQL(filters);
    const queryFloat = new Float32Array(vector);

    const rows = this.db.query(`
      SELECT v.id, v.embedding FROM nodes_vec v
      JOIN nodes n ON v.id = n.id
      WHERE ${where}
    `).all(...params) as { id: string; embedding: Uint8Array }[];

    if (rows.length === 0) return [];

    const scored = rows.map(row => {
      const stored = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      let dot = 0, normA = 0, normB = 0;
      for (let i = 0; i < queryFloat.length; i++) {
        dot += queryFloat[i] * stored[i];
        normA += queryFloat[i] * queryFloat[i];
        normB += stored[i] * stored[i];
      }
      return { id: row.id, sim: dot / (Math.sqrt(normA) * Math.sqrt(normB)) };
    });
    scored.sort((a, b) => b.sim - a.sim);

    const topIds = scored.slice(0, limit).map(r => r.id);
    if (topIds.length === 0) return [];

    const placeholders = topIds.map(() => '?').join(',');
    const nodes = this.db.query(
      `SELECT * FROM nodes WHERE id IN (${placeholders})`
    ).all(...topIds) as MemtreeNode[];

    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    return topIds.map(id => nodeMap.get(id)).filter((n): n is MemtreeNode => n !== undefined);
  }

  // ── Complex graph / tool queries ───────────────────────────────────────────

  async getNodesByIds(ids: string[]): Promise<MemtreeNode[]> {
    if (ids.length === 0) return [];
    const CHUNK = 999;
    const result: MemtreeNode[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db.query(
        `SELECT * FROM nodes WHERE id IN (${placeholders}) AND status = 'live'`
      ).all(...chunk) as MemtreeNode[];
      result.push(...rows);
    }
    return result;
  }

  async getRecentNodes(since?: number, limit = 50, filters: Filters = {}): Promise<MemtreeNode[]> {
    const effectiveFilters: Filters = { ...filters, ...(since ? { since } : {}) };
    const { where, params } = buildFilterSQL(effectiveFilters);
    return this.db.query(
      `SELECT * FROM nodes WHERE ${where} ORDER BY created_at DESC LIMIT ?`
    ).all(...params, limit) as MemtreeNode[];
  }

  async getPathToRoot(nodeId: string): Promise<MemtreeNode[]> {
    const path: MemtreeNode[] = [];
    let current = this.db.query('SELECT * FROM nodes WHERE id = ?').get(nodeId) as MemtreeNode | undefined;
    while (current) {
      path.push(current);
      if (!current.parent_id) break;
      current = this.db.query('SELECT * FROM nodes WHERE id = ?').get(current.parent_id) as MemtreeNode | undefined;
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
    const { where, params } = buildFilterSQL(filters, 'n');
    const kindFilter = edgeKinds?.length
      ? `AND e.kind IN (${edgeKinds.map(() => '?').join(',')})`
      : '';
    const kindParams = edgeKinds ?? [];

    const visited = new Set<string>([nodeId]);
    const result: MemtreeNode[] = [];
    let frontier = [nodeId];

    for (let d = 0; d < cap; d++) {
      if (frontier.length === 0) break;
      const placeholders = frontier.map(() => '?').join(',');
      const next = this.db.query(`
        SELECT DISTINCT n.* FROM nodes n
        JOIN edges e ON (e.src_id IN (${placeholders}) AND e.dst_id = n.id)
                     OR (e.dst_id IN (${placeholders}) AND e.src_id = n.id)
        WHERE ${where} ${kindFilter}
      `).all(...frontier, ...frontier, ...params, ...kindParams) as MemtreeNode[];

      const newNodes = next.filter(n => !visited.has(n.id));
      for (const n of newNodes) { visited.add(n.id); result.push(n); }
      frontier = newNodes.map(n => n.id);
    }

    return result;
  }

  async expandGraph(seedIds: string[], maxDepth: number): Promise<Map<string, number>> {
    const visited = new Map<string, number>();
    const queue: [string, number][] = seedIds.map(id => [id, 0]);

    while (queue.length > 0) {
      const entry = queue.shift();
      if (!entry) break;
      const [id, dist] = entry;
      if (visited.has(id)) continue;
      visited.set(id, dist);
      if (dist >= maxDepth) continue;

      const children = this.db.query(
        "SELECT id FROM nodes WHERE parent_id = ? AND status = 'live'"
      ).all(id) as { id: string }[];

      const edgeNeighbors = this.db.query(`
        SELECT DISTINCT n.id FROM nodes n
        JOIN edges e ON (e.src_id = ? AND e.dst_id = n.id)
                     OR (e.dst_id = ? AND e.src_id = n.id)
        WHERE n.status = 'live'
      `).all(id, id) as { id: string }[];

      for (const { id: nextId } of [...children, ...edgeNeighbors]) {
        if (!visited.has(nextId)) queue.push([nextId, dist + 1]);
      }
    }

    return visited;
  }

  async getFtsRanks(query: string, ids: string[]): Promise<Map<string, number>> {
    if (!query.trim() || ids.length === 0) return new Map();
    const CHUNK = 999;
    const rows: { id: string; rank: number }[] = [];
    try {
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        const batch = this.db.query(`
          SELECT n.id, bm25(nodes_fts) AS rank FROM nodes n
          JOIN nodes_fts f ON f.id = n.id
          WHERE nodes_fts MATCH ? AND n.id IN (${placeholders})
          ORDER BY rank
        `).all(query, ...chunk) as { id: string; rank: number }[];
        rows.push(...batch);
      }
    } catch {
      return new Map();
    }
    if (rows.length === 0) return new Map();
    const minRank = Math.min(...rows.map(r => r.rank));
    const maxRank = Math.max(...rows.map(r => r.rank));
    const range = maxRank - minRank || 1;
    return new Map(rows.map(r => [r.id, (maxRank - r.rank) / range]));
  }

  // ── Vector / embedding ─────────────────────────────────────────────────────

  async getPendingEmbeddingNodes(batchSize: number): Promise<Array<{ id: string; content: string }>> {
    return this.db.query<{ id: string; content: string }, [number]>(`
      SELECT n.id, n.content FROM nodes n
      LEFT JOIN nodes_vec v ON n.id = v.id
      WHERE n.status = 'live'
        AND v.id IS NULL
        AND length(n.content) > 0
      LIMIT ?
    `).all(batchSize);
  }

  async batchUpsertNodeVec(
    rows: Array<{ id: string; embedding: Buffer; model: string; dim: number; embeddedAt: number }>
  ): Promise<void> {
    const upsert = this.db.prepare(`
      INSERT OR REPLACE INTO nodes_vec (id, embedding, embedding_model, embedding_dim, embedded_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      for (const row of rows) {
        upsert.run(row.id, row.embedding, row.model, row.dim, row.embeddedAt);
      }
    })();
  }

  async getStoredEmbeddingModels(): Promise<string[]> {
    const rows = this.db.prepare(
      'SELECT DISTINCT embedding_model FROM nodes_vec LIMIT 2'
    ).all() as { embedding_model: string }[];
    return rows.map(r => r.embedding_model);
  }

  // ── Dedupe walker ──────────────────────────────────────────────────────────

  async getDedupeCandidatePairs(): Promise<Array<{
    id1: string; id2: string;
    emb1: Uint8Array; emb2: Uint8Array;
    ts1: number; ts2: number;
  }>> {
    return this.db.query(`
      SELECT n1.id as id1, n2.id as id2,
             v1.embedding as emb1, v2.embedding as emb2,
             n1.created_at as ts1, n2.created_at as ts2
      FROM nodes n1
      JOIN nodes n2 ON n1.source_uri = n2.source_uri AND n1.id < n2.id
      JOIN nodes_vec v1 ON n1.id = v1.id
      JOIN nodes_vec v2 ON n2.id = v2.id
      WHERE n1.kind = 'file_chunk'
        AND n2.kind = 'file_chunk'
        AND n1.status = 'live'
        AND n2.status = 'live'
        AND v1.embedding_model = v2.embedding_model
      LIMIT 50
    `).all() as any[];
  }

  async markNodeStatusPruned(id: string, now: number): Promise<void> {
    this.db.run(`UPDATE nodes SET status='pruned', updated_at=? WHERE id=?`, now, id);
  }

  // ── Summarizer walker ──────────────────────────────────────────────────────

  async getNodesNeedingSummarization(
    charThreshold: number,
    limit: number,
  ): Promise<Array<{ id: string; content: string; source_uri: string | null }>> {
    return this.db.query<{ id: string; content: string; source_uri: string | null }, [number, number]>(`
      SELECT id, content, source_uri FROM nodes
      WHERE status = 'live'
        AND (summary IS NULL OR summary = '')
        AND length(content) > ?
      LIMIT ?
    `).all(charThreshold, limit);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    closeDb(this.db);
  }
}
