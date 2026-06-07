import type { StoreBackend } from '../store/index.js';
import type { CtxTreeNode, ComposeManifest } from '../store/types.js';

export interface ComposeParams {
  node_ids: string[];
  budget_tokens: number;
  format?: 'raw' | 'outline' | 'mixed';
  query?: string;
  depth?: number;
}

export interface ComposeResult {
  content: string;
  manifest: ComposeManifest;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function scoreNode(
  node: CtxTreeNode,
  graphDistance: number,
  queryRank: number,
  hasQuery: boolean
): number {
  const wDist = 0.7;
  const wRecency = 0.3;
  const wQuery = hasQuery ? 0.1 : 0.0;
  const ageHours = (Date.now() - node.updated_at) / (1000 * 60 * 60);
  const recencyDecay = Math.exp(-ageHours / 24);
  return wDist * (1 / (1 + graphDistance)) + wRecency * recencyDecay + wQuery * queryRank;
}

function formatOutline(node: CtxTreeNode): string {
  const prefix = `[${node.id}] ${node.kind}: `;
  const suffix = '…';
  const maxPreview = Math.max(0, Math.min(120, node.content.length - prefix.length - suffix.length - 1));
  const preview = node.content.slice(0, maxPreview).replace(/\n/g, ' ');
  return `${prefix}${preview}${suffix}`;
}

export async function ctxTreeCompose(
  store: StoreBackend,
  params: ComposeParams
): Promise<ComposeResult> {
  const { node_ids, budget_tokens, format = 'raw', query } = params;
  const depth = Math.min(params.depth ?? 2, 2);

  const distanceMap = await store.expandGraph(node_ids, depth);
  if (distanceMap.size === 0) {
    return { content: '', manifest: { included: [], dropped: [], truncated: [] } };
  }

  const allIds = [...distanceMap.keys()];
  const candidates = await store.getNodesByIds(allIds);

  const ftsRanks = query
    ? await store.getFtsRanks(query, allIds)
    : new Map<string, number>();

  const scored = candidates.map(node => ({
    node,
    score: scoreNode(
      node,
      distanceMap.get(node.id) ?? 0,
      ftsRanks.get(node.id) ?? 0,
      !!query,
    ),
  }));
  scored.sort((a, b) => b.score - a.score);

  let budget = budget_tokens;
  const included: string[] = [];
  const dropped: ComposeManifest['dropped'] = [];
  const truncated: string[] = [];
  const summary_substituted: string[] = [];
  const parts: string[] = [];

  for (const { node } of scored) {
    if (node.status === 'superseded') {
      dropped.push({ id: node.id, reason: 'superseded' });
      continue;
    }
    if (node.status === 'pruned') {
      dropped.push({ id: node.id, reason: 'pruned' });
      continue;
    }

    let text = format === 'outline' ? formatOutline(node) : node.content;
    const usesSummary = format === 'mixed' && node.summary && node.summary.length < node.content.length;
    if (usesSummary) {
      text = node.summary!;
      summary_substituted.push(node.id);
    }

    const tokens = estimateTokens(text);
    if (tokens > budget) {
      if (budget < 50) {
        // mixed format: no summary available → specific drop reason
        if (format === 'mixed' && !node.summary) {
          dropped.push({ id: node.id, reason: 'over_budget_no_summary' });
        } else {
          dropped.push({ id: node.id, reason: 'over_budget' });
        }
        continue;
      }
      const chars = budget * 4;
      text = text.slice(0, chars);
    }
    budget -= estimateTokens(text);
    included.push(node.id);
    if (node.truncated === 1) truncated.push(node.id);
    parts.push(text);
  }

  return {
    content: parts.join('\n\n'),
    manifest: { included, dropped, truncated, ...(summary_substituted.length ? { summary_substituted } : {}) },
  };
}
