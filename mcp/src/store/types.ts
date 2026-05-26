export type NodeStatus = 'pending' | 'live' | 'stale' | 'superseded' | 'pruned';
export type NodeKind = 'session' | 'file_chunk' | 'tool_output' | 'summary' | 'note' | 'observation' | 'web_chunk';
export type EdgeKind = 'derived_from' | 'references' | 'summarizes' | 'supersedes';

export interface MemtreeNode {
  id: string;            // ULID
  parent_id: string | null;
  kind: NodeKind;
  source_uri: string | null;
  content: string;
  content_hash: string;  // sha256 hex
  status: NodeStatus;
  mtime: number;         // source file mtime epoch ms; 0 for non-file nodes
  created_at: number;    // epoch ms
  updated_at: number;    // epoch ms
  truncated: number;     // 0 | 1
  original_bytes: number;
  metadata: string;      // JSON blob
}

export interface MemtreeEdge {
  src_id: string;
  dst_id: string;
  kind: EdgeKind;
  created_at: number;    // epoch ms
}

export interface WalkerConfig {
  embeddingIdleMs: number;
  embeddingBatchSize: number;
  summarizerSubtreeThreshold: number;
  dedupeIntervalMs: number;
  stalenessIntervalMs: number;
  prunerIntervalMs: number;
}

export interface CaptureConfig {
  maxBytes: number;
  filterMinSize: number;
  bash?: boolean;
  read?: boolean;
  grep?: boolean;
  pathDenylistExtra?: string[];
}

export interface RetentionConfig {
  staleHours: number;
  supersededDays: number;
}

export interface MemtreeConfig {
  embeddingModel: string;
  summarizerModel: string;
  retention: RetentionConfig;
  walkers: WalkerConfig;
  capture: CaptureConfig;
}

export interface IngestPayload {
  tool: string;
  input: Record<string, unknown>;
  response: Record<string, unknown>;
  session_id: string | null;
  cwd: string;
  ts: number; // epoch ms
}

export type FilterResult = { action: 'accept' } | { action: 'drop'; reason: string };

export interface ComposeManifest {
  included: string[];
  dropped: Array<{ id: string; reason: 'over_budget' | 'superseded' | 'pruned' | 'filtered' }>;
  truncated: string[];
}

export interface Filters {
  status?: NodeStatus[];
  kind?: NodeKind[];
  since?: number;
  until?: number;
  parent_id?: string;
  session_id?: string;
}

// Provider interfaces — implementations are v1.1 (Ollama, OpenAI, Anthropic adapters).
export interface EmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface SummarizerProvider {
  readonly model: string;
  summarize(content: string, contextHint?: string): Promise<string>;
}

// Returns null providers in v1; v1.1 factory reads config and returns real impls.
export function loadProviders(_config: MemtreeConfig): {
  embedding: EmbeddingProvider | null;
  summarizer: SummarizerProvider | null;
} {
  return { embedding: null, summarizer: null };
}
