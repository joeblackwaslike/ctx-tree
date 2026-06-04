import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { StoreBackend } from '../store/index.js';
import type { CtxTreeNode, Filters, EmbeddingProvider, CtxTreeConfig } from '../store/types.js';

export interface SearchResult {
  nodes: CtxTreeNode[];
}

export async function searchKeyword(
  store: StoreBackend,
  query: string,
  limit = 20,
  filters: Filters = {}
): Promise<SearchResult> {
  const nodes = await store.searchKeyword(query, filters, limit);
  return { nodes };
}

export async function searchSemantic(
  store: StoreBackend,
  config: CtxTreeConfig,
  provider: EmbeddingProvider | null,
  query: string,
  limit = 20,
  filters: Filters = {}
): Promise<SearchResult> {
  if (!provider) {
    throw new McpError(ErrorCode.InvalidParams, 'semantic search requires an embedding provider');
  }
  const [queryVec] = await provider.embed([query]);
  const nodes = await store.searchSemantic(queryVec, provider.model, filters, limit);
  return { nodes };
}

export async function searchHybrid(
  store: StoreBackend,
  config: CtxTreeConfig,
  provider: EmbeddingProvider | null,
  query: string,
  limit = 20,
  filters: Filters = {}
): Promise<SearchResult> {
  if (!provider) {
    throw new McpError(ErrorCode.InvalidParams, 'hybrid search requires an embedding provider');
  }

  const keywordResults = (await searchKeyword(store, query, limit * 2, filters)).nodes;
  const semanticResults = (await searchSemantic(store, config, provider, query, limit * 2, filters)).nodes;

  const RRF_K = 60;
  const scores = new Map<string, number>();
  keywordResults.forEach((n, i) => scores.set(n.id, (scores.get(n.id) ?? 0) + 1 / (RRF_K + i + 1)));
  semanticResults.forEach((n, i) => scores.set(n.id, (scores.get(n.id) ?? 0) + 1 / (RRF_K + i + 1)));

  const allNodes = new Map<string, CtxTreeNode>();
  for (const n of [...keywordResults, ...semanticResults]) allNodes.set(n.id, n);

  const sorted = [...allNodes.values()].sort(
    (a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0)
  );
  return { nodes: sorted.slice(0, limit) };
}
