---
id: mcp-tools
title: Using the MCP Tools
sidebar_position: 3
---

# Using the MCP Tools

memtree exposes 10 MCP tools. This page covers practical usage patterns. For complete parameter reference, see [MCP Tools Reference](../reference/mcp-tools).

---

## memtree_read — Read files

Use instead of `Read` for any file you want to index and recall later.

```
memtree_read({ path: "src/server.ts" })
```

Returns a `nodeId` and chunk count. The file is stored with tree-sitter semantic chunking. Use `memtree_compose` to retrieve content within a budget.

**Line range reads** — read a specific section:

```
memtree_read({ path: "src/server.ts", lines: [1, 50] })
```

**Cache behavior**: If the file hasn't changed (mtime match), the existing node is returned instantly at zero cost.

---

## memtree_grep — Search file content

Use instead of `Grep` or `Bash` with `grep/rg` to search file content.

```
memtree_grep({ pattern: "export function", path: "src/" })
```

Each match is stored as a `tool_output` node. Results are returned as a list of `nodeId:path:line` references.

```
memtree_grep({ pattern: "handleToken", file_glob: "*.ts", case_insensitive: true })
```

---

## memtree_browse — Fetch URLs

Use instead of `WebFetch` for any URL you want to reference later.

```
memtree_browse({ url: "https://bun.sh/docs/api/spawn" })
```

Returns title, description, headings, and a content excerpt. The full accessibility tree is stored as a `web_chunk` node. Re-fetching the same URL returns the cached node.

Force a refresh:

```
memtree_browse({ url: "https://...", force: true })
```

---

## memtree_compose — Retrieve content

The primary recall tool. Given seed node IDs and a token budget, returns the most relevant content that fits.

```
memtree_compose({ node_ids: ["01HXX..."], budget_tokens: 4000 })
```

**With BFS expansion** — walk the graph from seeds and include related nodes:

```
memtree_compose({ node_ids: ["01HXX..."], budget_tokens: 8000, depth: 2 })
```

**With relevance scoring** — score by similarity to a query:

```
memtree_compose({
  node_ids: ["01HXX...", "01HYY..."],
  budget_tokens: 4000,
  query: "authentication middleware",
  depth: 2
})
```

**Outline format** — get a structured summary instead of raw content:

```
memtree_compose({ node_ids: ["01HXX..."], budget_tokens: 2000, format: "outline" })
```

---

## memtree_search — Keyword search

Search all stored nodes with BM25 full-text search.

```
memtree_search({ query: "authentication token validation" })
```

Filter by node kind:

```
memtree_search({ query: "database schema", filters: { kind: ["file_chunk"] } })
```

Filter to recent nodes:

```
memtree_search({
  query: "error handling",
  filters: { since: 1716000000000 }
})
```

Combine with `memtree_compose` to get the content of top results:

```
// 1. Search
const hits = await memtree_search({ query: "auth middleware", limit: 5 });
// 2. Compose
const context = await memtree_compose({ node_ids: hits.map(h => h.id), budget_tokens: 4000 });
```

---

## memtree_neighbors — Walk the graph

Explore what's connected to a node — callers, imports, siblings, summaries.

```
memtree_neighbors({ node_id: "01HXX...", depth: 2 })
```

Filter by edge kind:

```
memtree_neighbors({ node_id: "01HXX...", edge_kinds: ["derived_from", "summarizes"] })
```

---

## memtree_recent — Orient on re-entry

Surface what was read in recent sessions. Use at the start of a new session to get oriented.

```
memtree_recent({ limit: 20 })
```

Filter to nodes from the last 24 hours:

```
memtree_recent({ since: Date.now() - 86400000, limit: 30 })
```

---

## memtree_note — Store observations

Persist any observation, decision, or context that isn't captured by reading files.

```
memtree_note({ content: "The auth middleware is intentionally synchronous due to passport.js constraints" })
```

```
memtree_note({
  title: "DB schema rationale",
  content: "We use a single nodes table with a kind discriminator instead of separate tables because ..."
})
```

Notes are `note` nodes — fully searchable and composable like any other node.

---

## memtree_monitor — Capture command output

Run shell commands and store their output. Use when the command produces large output you'll want to reference later.

```
memtree_monitor({ command: "bun test --reporter verbose 2>&1" })
```

:::warning Not sandboxed
`memtree_monitor` runs commands directly via `sh -c` — it does **not** go through Claude Code's permission model. Use it for read-only commands (tests, builds, inspections). Sensitive values in the output are redacted before storage.
:::

---

## memtree_path_to_root

Trace the parent chain from any node back to the session root. Useful for understanding the context in which a node was created.

```
memtree_path_to_root({ node_id: "01HXX..." })
```
