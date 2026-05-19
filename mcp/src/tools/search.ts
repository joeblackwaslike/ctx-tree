import type { Database } from 'bun:sqlite';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { MemtreeNode, Filters, EmbeddingProvider, MemtreeConfig } from '../store/types.js';
import { buildFilterSQL } from './filters.js';
import { cosineSimilarity } from '../walkers/dedupe.js';

export interface SearchResult {
  nodes: MemtreeNode[];
}

export function searchKeyword(
  db: Database,
  query: string,
  limit = 20,
  filters: Filters = {}
): SearchResult {
  if (!query.trim()) return { nodes: [] };
  const { where, params } = buildFilterSQL(filters);
  try {
    const nodes = db.query(`
      SELECT n.* FROM nodes n
      JOIN nodes_fts f ON f.id = n.id
      WHERE nodes_fts MATCH ? AND ${where}
      ORDER BY bm25(nodes_fts)
      LIMIT ?
    `).all(query, ...params, limit) as MemtreeNode[];
    return { nodes };
  } catch {
    return { nodes: [] };
  }
}

function checkModelMismatch(db: Database, config: MemtreeConfig): void {
  const storedModels = db.prepare(
    `SELECT DISTINCT embedding_model FROM nodes_vec LIMIT 2`
  ).all() as { embedding_model: string }[];
  if (
    storedModels.length > 1 ||
    (storedModels[0] && storedModels[0].embedding_model !== config.embeddingModel)
  ) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `embedding model mismatch: re-embed required before semantic search`
    );
  }
}

export async function searchSemantic(
  db: Database,
  config: MemtreeConfig,
  provider: EmbeddingProvider | null,
  query: string,
  limit = 20,
  filters: Filters = {}
): Promise<SearchResult> {
  if (!provider) {
    throw new McpError(ErrorCode.InvalidParams, 'semantic search requires an embedding provider');
  }

  checkModelMismatch(db, config);

  const { where, params } = buildFilterSQL(filters);

  const [queryVec] = await provider.embed([query]);
  const queryFloat = new Float32Array(queryVec);

  const rows = db.query(`
    SELECT v.id, v.embedding FROM nodes_vec v
    JOIN nodes n ON v.id = n.id
    WHERE ${where}
  `).all(...params) as { id: string; embedding: Uint8Array }[];

  if (rows.length === 0) return { nodes: [] };

  const scored = rows.map(row => {
    const storedVec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
    const sim = cosineSimilarity(queryFloat, storedVec);
    return { id: row.id, sim };
  });
  scored.sort((a, b) => b.sim - a.sim);
  const topIds = scored.slice(0, limit).map(r => r.id);

  if (topIds.length === 0) return { nodes: [] };

  const placeholders = topIds.map(() => '?').join(',');
  const nodes = db.query(`
    SELECT * FROM nodes WHERE id IN (${placeholders})
  `).all(...topIds) as MemtreeNode[];

  // Restore sort order from scored results
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const orderedNodes = topIds.map(id => nodeMap.get(id)).filter((n): n is MemtreeNode => n !== undefined);

  return { nodes: orderedNodes };
}

export async function searchHybrid(
  db: Database,
  config: MemtreeConfig,
  provider: EmbeddingProvider | null,
  query: string,
  limit = 20,
  filters: Filters = {}
): Promise<SearchResult> {
  if (!provider) {
    throw new McpError(ErrorCode.InvalidParams, 'hybrid search requires an embedding provider');
  }

  checkModelMismatch(db, config);

  const keywordResults = searchKeyword(db, query, limit * 2, filters).nodes;
  const semanticResults = (await searchSemantic(db, config, provider, query, limit * 2, filters)).nodes;

  const RRF_K = 60;
  const scores = new Map<string, number>();
  keywordResults.forEach((n, i) => scores.set(n.id, (scores.get(n.id) ?? 0) + 1 / (RRF_K + i + 1)));
  semanticResults.forEach((n, i) => scores.set(n.id, (scores.get(n.id) ?? 0) + 1 / (RRF_K + i + 1)));

  // Merge all unique nodes
  const allNodes = new Map<string, MemtreeNode>();
  for (const n of [...keywordResults, ...semanticResults]) {
    allNodes.set(n.id, n);
  }

  const sorted = [...allNodes.values()].sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));
  return { nodes: sorted.slice(0, limit) };
}
