---
id: data-model
title: Data Model
sidebar_position: 3
---

# Data Model

Annotated schema for the ctx-tree SQLite store, with rationale for key design decisions.

---

## Overview

The store is a **tree-spined property graph**:

- Every node has exactly one `parent_id` (the spine) — this is the primary navigation surface
- Lateral semantic relationships live in a separate `edges` table
- All retrieval queries (search, compose, neighbors) walk the spine first, then fan out via edges

This dual structure lets `ctx_tree_compose` do efficient BFS expansion while keeping the parent-child hierarchy queryable with simple B-tree lookups.

---

## Core tables

### nodes

The central table. Every piece of captured content is a row.

```sql
CREATE TABLE nodes (
  id             TEXT PRIMARY KEY,      -- ULID (time-sortable, globally unique)
  parent_id      TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  kind           TEXT NOT NULL,         -- discriminator column
  source_uri     TEXT,                  -- canonical dedup key
  content        TEXT NOT NULL DEFAULT '',
  content_hash   TEXT NOT NULL,         -- sha256(content) hex
  status         TEXT NOT NULL DEFAULT 'live' CHECK(status IN ('pending','live','stale','superseded','pruned')),
  mtime          INTEGER NOT NULL DEFAULT 0,  -- source file mtime; 0 for non-file nodes
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  truncated      INTEGER NOT NULL DEFAULT 0 CHECK(truncated IN (0,1)),
  original_bytes INTEGER NOT NULL DEFAULT 0,
  metadata       TEXT NOT NULL DEFAULT '{}'  -- JSON blob
);
```

**Why ULID?** ULIDs are time-sortable (48-bit ms timestamp prefix) and globally unique without a central counter. They sort lexicographically in chronological order, making `ORDER BY id` equivalent to `ORDER BY created_at` for nodes created in the same process.

**Why `source_uri`?** Deduplication key. File nodes use `file:///absolute/path`, grep nodes use `grep://<hash>`, monitor nodes use `cmd://<hash>`. Two nodes with the same `source_uri` represent the same source at different points in time — the newer one adds a `supersedes` edge pointing at the older one.

### edges

Lateral semantic relationships between nodes.

```sql
CREATE TABLE edges (
  src_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  dst_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (src_id, dst_id, kind)
);
```

**Why a separate table?** `parent_id` handles the tree spine (fast B-tree). The `edges` table handles many-to-many semantic relationships that can't be represented in a single FK column. Keeping them separate means tree queries never touch the edges table.

### fts (FTS5 virtual table)

```sql
CREATE VIRTUAL TABLE fts USING fts5(
  content,
  content='nodes',
  content_rowid='rowid',
  tokenize='porter unicode61'
);
```

Porter stemming normalizes common English variations (`running` → `run`). All `live` nodes are indexed. FTS is kept in sync via triggers on `nodes`.

---

## Indexes

```sql
-- Primary query paths
CREATE INDEX idx_nodes_kind_status ON nodes(kind, status);
CREATE INDEX idx_nodes_created     ON nodes(created_at DESC);
CREATE INDEX idx_nodes_parent      ON nodes(parent_id);
CREATE INDEX idx_nodes_source      ON nodes(source_uri);
CREATE INDEX idx_nodes_hash        ON nodes(content_hash);

-- Edge traversal
CREATE INDEX idx_edges_src  ON edges(src_id, kind);
CREATE INDEX idx_edges_dst  ON edges(dst_id, kind);
```

The composite `(kind, status)` index covers the most common filter pattern: `WHERE kind = 'file_chunk' AND status = 'live'`.

---

## Node kind reference

### session

**Created by:** `session-start.mjs` hook (lazy — on first capture in a session)  
**parent_id:** NULL (tree root)  
**source_uri:** `session://<session_id>`

```json
// metadata
{
  "session_id": "abc123",
  "cwd": "/Users/joe/github/myproject",
  "started_at": 1716000000000
}
```

All nodes produced during a session are descendants of this root. This gives you a clean "what happened this session" subtree queryable with `WHERE parent_id = '<session_id>'`.

### file_chunk

**Created by:** `ctx_tree_read`  
**parent_id:** File's root chunk node (the `file_chunk` with `metadata.is_file_root=true`)  
**source_uri:** `file:///absolute/path/to/file.ts` (root), `file:///path/to/file.ts#FunctionName` (symbol)

```json
// metadata (root chunk)
{
  "path": "/Users/joe/project/src/server.ts",
  "lang": "typescript",
  "is_file_root": true,
  "total_chunks": 4
}

// metadata (symbol chunk)
{
  "path": "/Users/joe/project/src/server.ts",
  "lang": "typescript",
  "lines": [42, 80],
  "chunk_index": 2,
  "symbol": "handleRequest",
  "chunking": "tree-sitter"
}
```

**Cache behavior:** On read, if `mtime` of the source file matches the stored node, the existing node is returned instantly. If `mtime` advanced, the old nodes are marked `stale`, new nodes are created, and `supersedes` edges wire newer → older.

### tool_output

**Created by:** `ctx_tree_grep`, `ctx_tree_monitor`  
**parent_id:** Current session node  
**source_uri:** `grep://<hash>` or `cmd://<hash>`

```json
// grep metadata
{
  "pattern": "export function",
  "path": "src/",
  "file_glob": "*.ts",
  "match_count": 12,
  "cwd": "/Users/joe/project"
}

// monitor metadata
{
  "command": "bun test 2>&1",
  "exit_code": 0,
  "cwd": "/Users/joe/project"
}
```

### web_chunk

**Created by:** `ctx_tree_browse`, `posttooluse-websearch-capture.mjs`  
**parent_id:** Current session node  
**source_uri:** The URL

```json
// metadata
{
  "url": "https://bun.sh/docs/api/spawn",
  "title": "Bun.spawn | Bun Docs",
  "description": "Start child processes in Bun...",
  "headings": ["Bun.spawn()", "Options", "stdout/stderr"],
  "fetched_at": 1716000000000
}
```

### prompt / thinking / response

**Created by:** `userpromptsubmit-capture.mjs` (prompt), `stop-response-capture.mjs` (thinking, response)  
**parent_id:** Current session node

```json
// prompt metadata
{
  "session_id": "abc123",
  "title": "Read the auth middleware and tell me why...",
  "cwd": "/Users/joe/project",
  "turn_index": 3
}
```

### summary

**Created by:** `posttooluse-agent-capture.mjs`, summarization walker  
**parent_id:** Subtree root being summarized

```json
// metadata
{
  "session_id": "abc123",
  "source_node_ids": ["01HXX...", "01HYY..."],
  "model": "claude-haiku-4-5",
  "subtree_size": 12
}
```

### note

**Created by:** `ctx_tree_note`  
**parent_id:** Current session node (or explicit `parent_id` from caller)  
**source_uri:** `note://<ulid>`

```json
// metadata
{
  "title": "Auth middleware is sync due to passport.js constraints",
  "session_id": "abc123"
}
```

---

## Edge kind reference

### follows

`A --follows--> B` means A came after B in conversation flow.

```
prompt_3 --follows--> response_2
response_2 --follows--> prompt_2
```

Enables forward/backward traversal of the conversation thread.

### derived_from

`A --derived_from--> B` means A was produced using information from B.

```
response --derived_from--> file_chunk (referenced this session)
response --derived_from--> tool_output (grep result used)
thinking --derived_from--> response (thinking associated with response)
```

### summarizes

`summary --summarizes--> node` for each node covered.

```
agent_summary --summarizes--> file_chunk_1
agent_summary --summarizes--> file_chunk_2
agent_summary --summarizes--> tool_output_1
```

### supersedes

`new_node --supersedes--> old_node` when a fresher version replaces a stale one.

```
file_chunk_v2 --supersedes--> file_chunk_v1
```

The old node's `status` becomes `superseded`. Default queries filter it out.

### references

Generic cross-reference for weaker semantic links that don't fit the above.

---

## Configuration reference

```typescript
interface CtxTreeConfig {
  embeddingModel: string;        // default: "nomic-embed-text"
  summarizerModel: string;       // default: "claude-haiku-4-5"
  retention: {
    staleHours: number;          // default: 24
    supersededDays: number;      // default: 7
  };
  walkers: {
    embeddingIdleMs: number;     // default: 5000
    embeddingBatchSize: number;  // default: 32
    summarizerSubtreeThreshold: number; // default: 25
    dedupeIntervalMs: number;    // default: 60000
    stalenessIntervalMs: number; // default: 30000
    prunerIntervalMs: number;    // default: 300000
  };
  capture: {
    maxBytes: number;            // default: 100000
    filterMinSize: number;       // default: 50
    bash?: boolean;              // capture Bash outputs (v1.1)
    read?: boolean;              // capture Read outputs (v1.1)
    grep?: boolean;              // capture Grep outputs (v1.1)
  };
}
```
