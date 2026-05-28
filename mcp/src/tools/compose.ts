import type { Database } from 'bun:sqlite';
import type { MemtreeNode, ComposeManifest } from '../store/types';

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
  node: MemtreeNode,
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

function expandGraph(
  db: Database,
  seedIds: string[],
  maxDepth: number
): Map<string, number> {
  const visited = new Map<string, number>();
  const queue: [string, number][] = seedIds.map(id => [id, 0]);

  while (queue.length > 0) {
    const [id, dist] = queue.shift()!;
    if (visited.has(id)) continue;
    visited.set(id, dist);
    if (dist >= maxDepth) continue;

    const children = db.query(
      "SELECT id FROM nodes WHERE parent_id = ? AND status = 'live'"
    ).all(id) as { id: string }[];

    const edgeNeighbors = db.query(`
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

function getFtsRanks(db: Database, query: string, ids: string[]): Map<string, number> {
  if (!query.trim() || ids.length === 0) return new Map();
  const CHUNK = 999;
  let rows: { id: string; rank: number }[] = [];
  try {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const batch = db.query(`
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

function formatOutline(node: MemtreeNode): string {
  // Prefix: "[<id>] <kind>: " + "…" — ensure the outline is always shorter than raw content.
  const prefix = `[${node.id}] ${node.kind}: `;
  const suffix = '…';
  const maxPreview = Math.max(0, Math.min(120, node.content.length - prefix.length - suffix.length - 1));
  const preview = node.content.slice(0, maxPreview).replace(/\n/g, ' ');
  return `${prefix}${preview}${suffix}`;
}

export async function memtreeCompose(
  db: Database,
  params: ComposeParams
): Promise<ComposeResult> {
  const { node_ids, budget_tokens, format = 'raw', query } = params;
  const depth = Math.min(params.depth ?? 2, 2);

  const distanceMap = expandGraph(db, node_ids, depth);
  if (distanceMap.size === 0) {
    return { content: '', manifest: { included: [], dropped: [], truncated: [] } };
  }

  const allIds = [...distanceMap.keys()];
  const CHUNK = 999;
  const candidates: MemtreeNode[] = [];
  for (let i = 0; i < allIds.length; i += CHUNK) {
    const chunk = allIds.slice(i, i + CHUNK);
    const rows = db.query(
      `SELECT * FROM nodes WHERE id IN (${chunk.map(() => '?').join(',')}) AND status = 'live'`
    ).all(...chunk) as MemtreeNode[];
    candidates.push(...rows);
  }

  const ftsRanks = query ? getFtsRanks(db, query, allIds) : new Map<string, number>();
  const hasQuery = !!query;

  const scored = candidates.map(node => ({
    node,
    score: scoreNode(node, distanceMap.get(node.id) ?? 99, ftsRanks.get(node.id) ?? 0, hasQuery),
  })).sort((a, b) => b.score - a.score);

  // contentItems preserves scored order for mixed format
  const contentItems: Array<{ id: string; text: string }> = [];
  const included: MemtreeNode[] = [];
  const dropped: ComposeManifest['dropped'] = [];
  const summarySubstituted: string[] = [];
  let usedTokens = 0;

  for (const { node } of scored) {
    const tokens = estimateTokens(format === 'outline' ? formatOutline(node) : node.content);
    if (usedTokens + tokens <= budget_tokens) {
      included.push(node);
      contentItems.push({ id: node.id, text: format === 'outline' ? formatOutline(node) : node.content });
      usedTokens += tokens;
    } else if (format === 'mixed') {
      // Try summary substitution
      const summary = node.summary ?? null;
      if (summary && summary.trim()) {
        const summaryTokens = estimateTokens(summary);
        if (usedTokens + summaryTokens <= budget_tokens) {
          // Use summary instead of raw content
          included.push(node);
          contentItems.push({ id: node.id, text: summary });
          summarySubstituted.push(node.id);
          usedTokens += summaryTokens;
        } else {
          // Summary also too big — drop
          dropped.push({ id: node.id, reason: 'over_budget_no_summary' });
        }
      } else {
        // No summary available — drop
        dropped.push({ id: node.id, reason: 'over_budget_no_summary' });
      }
    } else {
      dropped.push({ id: node.id, reason: 'over_budget' });
    }
  }

  const liveIds = new Set(candidates.map(n => n.id));
  for (const id of node_ids) {
    if (!liveIds.has(id)) {
      const n = db.query('SELECT status FROM nodes WHERE id = ?').get(id) as { status: string } | undefined;
      if (n && (n.status === 'superseded' || n.status === 'pruned')) {
        dropped.push({ id, reason: n.status as 'superseded' | 'pruned' });
      }
    }
  }

  const truncated = included.filter(n => n.truncated === 1).map(n => n.id);

  let content: string;
  if (format === 'outline') {
    content = contentItems.map(item => item.text).join('\n');
  } else if (format === 'mixed') {
    content = contentItems.map(item => item.text).join('\n\n---\n\n');
  } else {
    content = contentItems.map(item => item.text).join('\n\n---\n\n');
  }

  const manifest: ComposeManifest = {
    included: included.map(n => n.id),
    dropped,
    truncated,
  };
  if (format === 'mixed' && summarySubstituted.length > 0) {
    manifest.summary_substituted = summarySubstituted;
  }

  return { content, manifest };
}
