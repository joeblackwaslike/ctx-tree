import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { StoreBackend } from '../store/index.js';
import type { MemtreeConfig } from '../store/types.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

export interface BrowseParams {
  url: string;
  budget_tokens?: number;
  force?: boolean;        // bypass cache
}

export interface BrowseResult {
  nodeId: string;
  url: string;
  title: string;
  description: string;
  headings: string[];
  content: string;
  truncated: boolean;
  cached: boolean;
}

// ── HTML extraction helpers ───────────────────────────────────────────────────

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(stripTags(m[1])).trim() : '';
}

function extractMeta(html: string, name: string): string {
  const byName = html.match(
    new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']*?)["']`, 'i')
  ) ?? html.match(
    new RegExp(`<meta[^>]+content=["']([^"']*?)["'][^>]+name=["']${name}["']`, 'i')
  );
  if (byName) return byName[1].trim();
  // og:description fallback
  const og = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*?)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']*?)["'][^>]+property=["']og:description["']/i);
  return og ? og[1].trim() : '';
}

function extractHeadings(html: string): string[] {
  const re = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi;
  const headings: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && headings.length < 12) {
    const text = decodeEntities(stripTags(m[2])).trim();
    if (text) headings.push(text);
  }
  return headings;
}

function extractBodyText(html: string): string {
  // Remove noisy blocks before stripping tags
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

  // Prefer <main> or <article> body if present
  const main = cleaned.match(/<(?:main|article)[^>]*>([\s\S]*?)<\/(?:main|article)>/i)?.[1] ?? cleaned;

  return decodeEntities(stripTags(main))
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Cache TTL: 1 hour ─────────────────────────────────────────────────────────
const CACHE_TTL_MS = 60 * 60 * 1000;

// ── Main function ─────────────────────────────────────────────────────────────

export async function memtreeBrowse(
  store: StoreBackend,
  _config: MemtreeConfig,
  params: BrowseParams
): Promise<BrowseResult> {
  const { url, budget_tokens = 2000, force = false } = params;

  if (!url || typeof url !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, '"url" is required and must be a string');
  }

  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new McpError(ErrorCode.InvalidParams, `Invalid URL: ${url}`);
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new McpError(ErrorCode.InvalidParams, `Only http/https URLs are supported`);
  }

  // Cache check (skip if force=true or node is stale)
  if (!force) {
    const cached = await store.getNodeBySourceUri(url);
    if (cached && Date.now() - cached.updated_at < CACHE_TTL_MS) {
      const meta = JSON.parse(cached.metadata) as {
        title: string; description: string; headings: string[];
      };
      const bodyText = budgetContent(cached.content, budget_tokens);
      return {
        nodeId: cached.id,
        url,
        title: meta.title ?? '',
        description: meta.description ?? '',
        headings: meta.headings ?? [],
        content: bodyText.text,
        truncated: bodyText.truncated,
        cached: true,
      };
    }
  }

  // Fetch
  let html: string;
  let fetchedBytes: number;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'memtree/1.0 (https://github.com/joeblackwaslike/memtree)' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new McpError(ErrorCode.InvalidParams, `HTTP ${res.status} fetching ${url}`);
    }
    html = await res.text();
    fetchedBytes = Buffer.byteLength(html, 'utf8');
  } catch (err) {
    if (err instanceof McpError) throw err;
    throw new McpError(ErrorCode.InternalError, `Failed to fetch ${url}: ${(err as Error).message}`);
  }

  // Extract
  const title       = extractTitle(html);
  const description = extractMeta(html, 'description');
  const headings    = extractHeadings(html);
  const bodyText    = extractBodyText(html);

  const { text: content, truncated } = budgetContent(bodyText, budget_tokens);
  const contentHash = createHash('sha256').update(bodyText).digest('hex');

  // Check for existing node with same content (avoid duplicate storage)
  const existing = await store.getNodeBySourceUri(url);
  if (existing) {
    if (existing.content_hash === contentHash) {
      return { nodeId: existing.id, url, title, description, headings, content, truncated, cached: true };
    }
    await store.updateNodeStatus(existing.id, 'stale');
  }

  // Store new node
  const nodeId = ulid();
  await store.insertNode(nodeId, {
    parent_id: null,
    kind: 'web_chunk',
    source_uri: url,
    content: bodyText,
    content_hash: contentHash,
    status: 'live',
    mtime: Date.now(),
    truncated: truncated ? 1 : 0,
    original_bytes: fetchedBytes,
    metadata: JSON.stringify({ url, title, description, headings }),
  });

  if (existing) {
    await store.insertEdge({ src_id: nodeId, dst_id: existing.id, kind: 'supersedes' });
  }

  return { nodeId, url, title, description, headings, content, truncated, cached: false };
}

function budgetContent(text: string, budget: number): { text: string; truncated: boolean } {
  if (estimateTokens(text) <= budget) return { text, truncated: false };
  const charBudget = budget * 4;
  return { text: text.slice(0, charBudget), truncated: true };
}
