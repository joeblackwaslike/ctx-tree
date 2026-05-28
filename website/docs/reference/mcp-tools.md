---
id: mcp-tools
title: MCP Tools Reference
sidebar_position: 2
---

# MCP Tools Reference

Complete parameter reference for all 10 memtree MCP tools.

---

## memtree_read

Read a file with tree-sitter semantic chunking and mtime caching.

```typescript
memtree_read({
  path: string;           // required — absolute or relative file path
  lines?: [number, number]; // optional — [start, end] line range (0-based)
  budget_tokens?: number; // optional — token budget for chunking
})
```

**Returns:**
```typescript
{
  nodeId: string;
  path: string;
  cached: boolean;
  chunks: number;
  hint: string; // how to retrieve content via memtree_compose
}
```

---

## memtree_grep

Ripgrep search — results stored as typed graph nodes.

```typescript
memtree_grep({
  pattern: string;          // required — regex pattern to search
  path?: string;            // optional — path to search within (default: cwd)
  case_insensitive?: boolean; // optional — case-insensitive search
  file_glob?: string;       // optional — file glob filter (e.g. "*.ts")
})
```

**Returns:**
```typescript
{
  matches: string[]; // "nodeId path:line" entries
  pattern: string;
  count: number;
}
```

---

## memtree_browse

Fetch a URL, extract structured text, store as a `web_chunk` node.

```typescript
memtree_browse({
  url: string;             // required — HTTP/HTTPS URL to fetch
  budget_tokens?: number;  // optional — token budget for body content
  force?: boolean;         // optional — bypass cache and re-fetch
})
```

**Returns:**
```typescript
{
  nodeId: string;
  url: string;
  title: string;
  description: string;
  headings: string[];
  cached: boolean;
  truncated: boolean;
  content: string; // excerpt within budget
}
```

---

## memtree_compose

BFS graph expansion + relevance scoring + budget-packing into a single context block.

```typescript
memtree_compose({
  node_ids: string[];       // required — seed node IDs
  budget_tokens: number;    // required — token budget for output
  format?: 'raw' | 'outline'; // optional — output format (default: 'raw')
  query?: string;           // optional — query for relevance scoring
  depth?: number;           // optional — BFS expansion depth (default: 1)
})
```

**Returns:** A formatted content block followed by a manifest JSON:
```typescript
{
  content: string;
  manifest: {
    included: string[];
    dropped: Array<{ id: string; reason: string }>;
    truncated: string[];
  }
}
```

---

## memtree_search

FTS5 keyword search across all stored nodes.

```typescript
memtree_search({
  query: string;           // required — search query
  mode?: 'keyword';        // optional — search mode (only 'keyword' supported)
  limit?: number;          // optional — max results (default: 20)
  filters?: {
    status?: NodeStatus[];
    kind?: NodeKind[];
    since?: number;        // epoch ms lower bound
    until?: number;        // epoch ms upper bound
  };
})
```

**Returns:** `Array<{ id: string; kind: string; score: number; excerpt: string }>`

---

## memtree_neighbors

Graph walk from a node — returns neighbors up to depth 5.

```typescript
memtree_neighbors({
  node_id: string;         // required — starting node ID
  depth?: number;          // optional — walk depth, max 5 (default: 1)
  edge_kinds?: EdgeKind[]; // optional — edge kinds to traverse
  filters?: Filters;       // optional — filter neighbors
})
```

**Returns:** `Array<{ id: string; kind: string; edge_kind: string; distance: number }>`

---

## memtree_path_to_root

Walk the parent chain from any node to the session root.

```typescript
memtree_path_to_root({
  node_id: string; // required — node ID to trace
})
```

**Returns:** `Array<{ id: string; kind: string; depth: number }>`

---

## memtree_recent

Return the most recently created nodes, newest first.

```typescript
memtree_recent({
  since?: number;    // optional — Unix timestamp lower bound (epoch ms)
  limit?: number;    // optional — max results (default: 20)
  filters?: Filters; // optional
})
```

**Returns:** `Array<{ id: string; kind: string; created_at: number; excerpt: string }>`

---

## memtree_note

Store a note or observation in the graph.

```typescript
memtree_note({
  content: string; // required — note content
  title?: string;  // optional — short title (derived from first line if omitted)
})
```

**Returns:** `{ nodeId: string; title: string }`

---

## memtree_monitor

Run a shell command via `sh -c`, capture output as a stored node.

:::warning Not sandboxed
This tool executes directly — it does **not** go through Claude Code's permission model. Sensitive values are redacted before storage.
:::

```typescript
memtree_monitor({
  command: string;      // required — shell command to run
  timeout_ms?: number;  // optional — timeout in ms (default: 30000)
  cwd?: string;         // optional — working directory (default: process cwd)
})
```

**Returns:**
```typescript
{
  nodeId: string;
  command: string;
  exit_code: number;
  lines_captured: number;
  cached: boolean;
  preview: string; // last ~500 chars of output
  hint: string;    // how to retrieve full output via memtree_compose
}
```

---

## Type reference

### NodeKind

```typescript
type NodeKind =
  | 'session'
  | 'file_chunk'
  | 'tool_output'
  | 'summary'
  | 'note'
  | 'observation'
  | 'web_chunk'
  | 'prompt'
  | 'thinking'
  | 'response';
```

### EdgeKind

```typescript
type EdgeKind =
  | 'derived_from'
  | 'references'
  | 'summarizes'
  | 'supersedes'
  | 'follows';
```

### NodeStatus

```typescript
type NodeStatus = 'pending' | 'live' | 'stale' | 'superseded' | 'pruned';
```
