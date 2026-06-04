---
id: graph-schema
title: Graph Schema
sidebar_position: 4
---

# Graph Schema

The ctx-tree store is a SQLite property graph. This page documents every node kind, edge kind, metadata schema, and store layout.

---

## Store location

```
~/.ctx-tree/<project-hash>/store.db
```

Project hash: `sha256(git_root + ":" + first_commit_sha).slice(0, 16)`  
Fallback (not a git repo): `sha256(absolute_cwd).slice(0, 16)`

---

## Node schema

```sql
CREATE TABLE nodes (
  id             TEXT PRIMARY KEY,      -- ULID
  parent_id      TEXT REFERENCES nodes(id),
  kind           TEXT NOT NULL,
  source_uri     TEXT,                  -- canonical identifier
  content        TEXT NOT NULL,
  content_hash   TEXT NOT NULL,         -- sha256 hex
  status         TEXT NOT NULL DEFAULT 'live',
  mtime          INTEGER NOT NULL,      -- source file mtime (epoch ms); 0 for non-file nodes
  created_at     INTEGER NOT NULL,      -- epoch ms
  updated_at     INTEGER NOT NULL,      -- epoch ms
  truncated      INTEGER NOT NULL DEFAULT 0,  -- 0 | 1
  original_bytes INTEGER NOT NULL,
  metadata       TEXT NOT NULL DEFAULT '{}'   -- JSON
);
```

---

## Node kinds

### session

Created on `SessionStart`. All nodes produced during a session have this as an ancestor.

```typescript
// metadata
{
  session_id: string;   // Claude Code session ID
  cwd: string;          // working directory at session start
  started_at: number;   // epoch ms
}
```

### file_chunk

A semantic chunk of a source file, created by `ctx_tree_read`.

```typescript
// source_uri: file:///absolute/path/to/file.ts
// parent_id: root file_chunk node for the same file

// metadata
{
  path: string;         // absolute file path
  lang: string;         // tree-sitter language (typescript, python, ...)
  lines: [number, number]; // [start, end] 0-based line range
  chunk_index: number;  // position within the file's chunks
  symbol?: string;      // function/class name if known
}
```

### tool_output

Output from `ctx_tree_grep` or `ctx_tree_monitor`. A single grep run produces one `tool_output` node containing all matches.

```typescript
// source_uri: cmd://<sha256-prefix> (for monitor) or grep://<hash>
// metadata
{
  command?: string;     // for monitor nodes
  exit_code?: number;   // for monitor nodes
  pattern?: string;     // for grep nodes
  cwd: string;
}
```

### web_chunk

A fetched URL, created by `ctx_tree_browse`. Content is the extracted accessibility tree.

```typescript
// source_uri: the URL
// metadata
{
  url: string;
  title: string;
  description: string;
  headings: string[];
  fetched_at: number;   // epoch ms
}
```

### prompt

A user prompt, captured by `userpromptsubmit-capture.mjs`.

```typescript
// source_uri: prompt://<hash-prefix>
// metadata
{
  session_id: string;
  title: string;        // first 80 chars
  cwd: string;
  turn_index: number;
}
```

### thinking

Claude's thinking/reasoning content, captured by `stop-response-capture.mjs`.

```typescript
// metadata
{
  session_id: string;
  turn_index: number;
  response_id: string;  // ID of the response node this belongs to
}
```

### response

Claude's assistant response, captured by `stop-response-capture.mjs`.

```typescript
// metadata
{
  session_id: string;
  turn_index: number;
  prompt_id: string;    // ID of the prompt node this responds to
}
```

### summary

A summarized view of a subtree, created by `posttooluse-agent-capture.mjs` or the summarization walker.

```typescript
// metadata
{
  session_id: string;
  source_node_ids: string[];  // nodes this summarizes
  model: string;              // model used for summarization
}
```

### note

A manually stored observation, created by `ctx_tree_note`.

```typescript
// source_uri: note://<ulid>
// metadata
{
  title: string;
  session_id?: string;
}
```

### observation

An automatically generated observation from pattern analysis. Reserved for future walker output.

---

## Edge schema

```sql
CREATE TABLE edges (
  src_id     TEXT NOT NULL REFERENCES nodes(id),
  dst_id     TEXT NOT NULL REFERENCES nodes(id),
  kind       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (src_id, dst_id, kind)
);
```

---

## Edge kinds

### follows

Sequential ordering. `A → B` means A came after B in the conversation flow.

- `prompt → previous_response` — this prompt followed that response
- `response → prompt` — this response follows that prompt

### derived_from

Semantic derivation. `A → B` means A was produced using information from B.

- `response → file_chunk` — the response referenced this file chunk
- `response → tool_output` — the response used this tool output
- `thinking → response` — thinking content associated with a response

### summarizes

`summary → node` for each node the summary covers.

### supersedes

`new_node → old_node` when a fresher version of the same source replaces a stale node.

- Triggers when `ctx_tree_read` or `ctx_tree_monitor` finds an existing node for the same source URI with a different content hash

### references

Generic cross-reference. `A → B` means A mentions or links to B without a stronger semantic relationship.

---

## FTS5 index

```sql
CREATE VIRTUAL TABLE fts USING fts5(
  content,
  content='nodes',
  content_rowid='rowid',
  tokenize='porter unicode61'
);
```

Porter stemming is enabled. Queries use `fts MATCH` with BM25 ranking.

---

## Indexes

```sql
CREATE INDEX idx_nodes_kind      ON nodes(kind);
CREATE INDEX idx_nodes_status    ON nodes(status);
CREATE INDEX idx_nodes_created   ON nodes(created_at);
CREATE INDEX idx_nodes_parent    ON nodes(parent_id);
CREATE INDEX idx_nodes_source    ON nodes(source_uri);
CREATE INDEX idx_nodes_hash      ON nodes(content_hash);
CREATE INDEX idx_edges_src       ON edges(src_id);
CREATE INDEX idx_edges_dst       ON edges(dst_id);
CREATE INDEX idx_edges_kind      ON edges(kind);
```

---

## WAL mode

The database runs in WAL mode (`PRAGMA journal_mode=WAL`) for safe concurrent reads from background walkers alongside writes from tool calls and hooks.
