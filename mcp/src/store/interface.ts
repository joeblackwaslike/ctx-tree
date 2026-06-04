import type { CtxTreeNode, CtxTreeEdge, NodeStatus, NodeKind, EdgeKind, Filters } from './types.js';

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
  getNode(id: string): Promise<CtxTreeNode | null>;
  updateNodeStatus(id: string, status: NodeStatus): Promise<void>;
  getNodeBySourceUri(uri: string): Promise<CtxTreeNode | null>;
  getNodeByContentHash(hash: string): Promise<CtxTreeNode | null>;
  listChildren(parentId: string, status?: NodeStatus): Promise<CtxTreeNode[]>;
  getOrCreateSessionNode(sessionId: string): Promise<CtxTreeNode>;
  markStaleByFilePath(filePath: string, mtime: number): Promise<void>;
  countPendingNodes(): Promise<number>;
  getPendingNodes(limit?: number): Promise<CtxTreeNode[]>;
  getLiveFileChunks(cutoffMs: number): Promise<CtxTreeNode[]>;
  getStaleNodes(olderThanMs: number): Promise<CtxTreeNode[]>;
  getSupersededNodes(olderThanMs: number): Promise<CtxTreeNode[]>;
  pruneNode(id: string): Promise<void>;
  updateNodeSummary(id: string, summary: string): Promise<void>;

  // ── Edge CRUD ─────────────────────────────────────────────────────────────
  insertEdge(edge: Omit<CtxTreeEdge, 'created_at'>): Promise<void>;
  getNeighbors(nodeId: string, edgeKinds?: EdgeKind[]): Promise<CtxTreeNode[]>;
  getEdgesFrom(srcId: string): Promise<CtxTreeEdge[]>;

  // ── Search ────────────────────────────────────────────────────────────────
  // searchSemantic: vector is pre-computed; backend does cosine-similarity lookup.
  // EdgeLite: throws NotImplemented until Phase 8 wires pgvector.
  searchKeyword(query: string, filters?: Filters, limit?: number): Promise<CtxTreeNode[]>;
  searchSemantic(vector: number[], embeddingModel: string, filters?: Filters, limit?: number): Promise<CtxTreeNode[]>;

  // ── Complex graph / tool queries (EdgeLite: NotImplemented in Phase 7) ────
  getNodesByIds(ids: string[]): Promise<CtxTreeNode[]>;
  getRecentNodes(since?: number, limit?: number, filters?: Filters): Promise<CtxTreeNode[]>;
  getPathToRoot(nodeId: string): Promise<CtxTreeNode[]>;
  getNeighborsDeep(nodeId: string, depth?: number, edgeKinds?: EdgeKind[], filters?: Filters): Promise<CtxTreeNode[]>;
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
  /** Atomically mark pruneId as pruned and insert a supersedes edge from keepId → pruneId. */
  atomicPruneAndSupersede(pruneId: string, keepId: string, now: number): Promise<void>;

  // ── Summarizer walker (EdgeLite: NotImplemented in Phase 7) ───────────────
  getNodesNeedingSummarization(charThreshold: number, limit: number): Promise<Array<{
    id: string; content: string; source_uri: string | null;
  }>>;

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  close(): Promise<void>;
}
