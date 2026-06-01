import type { MemtreeNode, MemtreeEdge, NodeStatus, NodeKind, EdgeKind, Filters } from './types.js';

export interface InsertNodeParams {
  parent_id: string | null;
  kind: NodeKind;
  source_uri: string | null;
  content: string;
  content_hash: string;
  status: NodeStatus;
  mtime: number;
  truncated: number;       // 0 | 1
  original_bytes: number;
  metadata: string;        // JSON blob
  summary?: string | null;
}

export interface StoreBackend {
  // ── Core node CRUD ────────────────────────────────────────────────────────
  insertNode(id: string, params: InsertNodeParams): Promise<void>;
  getNode(id: string): Promise<MemtreeNode | null>;
  updateNodeStatus(id: string, status: NodeStatus): Promise<void>;
  getNodeBySourceUri(uri: string): Promise<MemtreeNode | null>;
  getNodeByContentHash(hash: string): Promise<MemtreeNode | null>;
  listChildren(parentId: string, status?: NodeStatus): Promise<MemtreeNode[]>;
  getOrCreateSessionNode(sessionId: string): Promise<MemtreeNode>;
  markStaleByFilePath(filePath: string, mtime: number): Promise<void>;
  countPendingNodes(): Promise<number>;
  getPendingNodes(limit?: number): Promise<MemtreeNode[]>;
  getLiveFileChunks(cutoffMs: number): Promise<MemtreeNode[]>;
  getStaleNodes(olderThanMs: number): Promise<MemtreeNode[]>;
  getSupersededNodes(olderThanMs: number): Promise<MemtreeNode[]>;
  pruneNode(id: string): Promise<void>;
  updateNodeSummary(id: string, summary: string): Promise<void>;

  // ── Edge CRUD ─────────────────────────────────────────────────────────────
  insertEdge(edge: Omit<MemtreeEdge, 'created_at'>): Promise<void>;
  getNeighbors(nodeId: string, edgeKinds?: EdgeKind[]): Promise<MemtreeNode[]>;
  getEdgesFrom(srcId: string): Promise<MemtreeEdge[]>;

  // ── Search ────────────────────────────────────────────────────────────────
  // searchSemantic: vector is pre-computed; backend does cosine-similarity lookup.
  // EdgeLite: throws NotImplemented until Phase 8 wires pgvector.
  searchKeyword(query: string, filters?: Filters, limit?: number): Promise<MemtreeNode[]>;
  searchSemantic(vector: number[], embeddingModel: string, filters?: Filters, limit?: number): Promise<MemtreeNode[]>;

  // ── Complex graph / tool queries (EdgeLite: NotImplemented in Phase 7) ────
  getNodesByIds(ids: string[]): Promise<MemtreeNode[]>;
  getRecentNodes(since?: number, limit?: number, filters?: Filters): Promise<MemtreeNode[]>;
  getPathToRoot(nodeId: string): Promise<MemtreeNode[]>;
  getNeighborsDeep(nodeId: string, depth?: number, edgeKinds?: EdgeKind[], filters?: Filters): Promise<MemtreeNode[]>;
  expandGraph(seedIds: string[], maxDepth: number): Promise<Map<string, number>>;
  getFtsRanks(query: string, ids: string[]): Promise<Map<string, number>>;

  // ── Vector / embedding (EdgeLite: NotImplemented in Phase 7) ─────────────
  getPendingEmbeddingNodes(batchSize: number): Promise<Array<{ id: string; content: string }>>;
  batchUpsertNodeVec(rows: Array<{ id: string; embedding: Buffer; model: string; dim: number; embeddedAt: number }>): Promise<void>;
  getStoredEmbeddingModels(): Promise<string[]>;

  // ── Dedupe walker (EdgeLite: NotImplemented in Phase 7) ───────────────────
  getDedupeCandidatePairs(): Promise<Array<{
    id1: string; id2: string;
    emb1: Uint8Array; emb2: Uint8Array;
    ts1: number; ts2: number;
  }>>;
  markNodeStatusPruned(id: string, now: number): Promise<void>;

  // ── Summarizer walker (EdgeLite: NotImplemented in Phase 7) ───────────────
  getNodesNeedingSummarization(charThreshold: number, limit: number): Promise<Array<{
    id: string; content: string; source_uri: string | null;
  }>>;

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  close(): Promise<void>;
}
