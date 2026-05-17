# memtree — Design Spec

**Date:** 2026-05-17
**Status:** Draft (awaiting user approval before implementation plan)
**Author:** Joe Black
**Repository:** github.com/joeblackwaslike/memtree

---

## 1. Problem & Goals

LLM context windows are a scarce, expensive, write-once resource. Tool outputs (Read, Grep, Bash) flood the window with low-signal data that compounds across turns; the model must then carry that ballast through every subsequent inference. Compaction helps but is lossy and not deterministic.

**memtree** is an external, persistent, tree- and graph-shaped context store with surgical recall. Native tool outputs are captured to it via hooks. The agent then retrieves only the bytes it needs through MCP tools — leaving raw outputs in the store, not in the window.

### Goals (v1)

- **Surgical recall.** The agent should be able to pull a tightly scoped slice of prior context (a function body, three related observations, a summarized branch) instead of re-reading whole files.
- **Parallel context.** Live alongside the active conversation; capture transparently; survive across sessions.
- **Multi-index.** Keyword (FTS5), semantic (sqlite-vec), tree (parent_id B-tree), and time-series (created_at) — all queryable individually or combined.
- **Self-maintaining.** Background walkers prune, dedupe, summarize, and supersede stale content without user intervention.
- **Local-first.** No cloud dependency for the store; embeddings via local Ollama; summarization via Anthropic API (soft dependency).

### Non-goals (v1)

- Multi-user / multi-machine sync.
- A VS Code or web UI (deferred to companion project — see §9).
- Replacing every native tool call (the agent still uses Read directly when appropriate; memtree augments, doesn't replace).

---

## 2. Storage Backend

### Engine: SQLite

Single-file embedded DB with:

- **FTS5** virtual table for keyword search.
- **sqlite-vec** extension for cosine-similarity vector search.
- **B-tree index** on `(created_at, parent_id)` for time- and tree-range queries.
- **WAL mode** for safe concurrent reads from walkers + writes from hooks.

### Storage Location

`~/.memtree/<project-hash>/store.db`

`<project-hash>` is computed at MCP-server startup:

1. Run `git rev-parse --show-toplevel` to get the git root.
2. Run `git rev-list --max-parents=0 HEAD` to get the first-commit SHA.
3. `project-hash = sha256(git_root_path + ":" + first_commit_sha).slice(0, 16)`
4. **Fallback** if not a git repo or either command fails: `project-hash = sha256(absolute_workspace_path).slice(0, 16)`.

The hash is cached in memory for the lifetime of the server process.

Rationale: stable across moves, renames, and clones; degrades gracefully for non-git directories.

### Sidecar config: `~/.memtree/config.json`

```json
{
  "embeddingModel": "nomic-embed-text",
  "summarizerModel": "claude-haiku-4-5",
  "retention": { "staleHours": 24, "supersededDays": 7 },
  "walkers": {
    "embeddingIdleMs": 5000,
    "embeddingBatchSize": 32,
    "summarizerSubtreeThreshold": 25,
    "dedupeIntervalMs": 60000,
    "stalenessIntervalMs": 30000,
    "prunerIntervalMs": 300000
  },
  "capture": { "maxBytes": 100000, "filterMinSize": 50 }
}
```

---

## 3. Node Schema & Relationships

memtree is a **tree-spined graph**: every node has exactly one `parent_id` (the spine), plus zero-or-more lateral edges in a separate `edges` table.

### `nodes` table

| Column         | Type     | Notes                                                          |
| -------------- | -------- | -------------------------------------------------------------- |
| `id`           | TEXT PK  | ULID (time-sortable)                                           |
| `parent_id`    | TEXT FK  | NULL for roots; indexed                                        |
| `kind`         | TEXT     | `file_chunk`, `tool_output`, `summary`, `note`, `observation`  |
| `source_uri`   | TEXT     | e.g., `file:///path#L10-42`, `tool:Bash#sha256`; dedup key     |
| `content`      | TEXT     | Raw bytes (capped by `capture.maxBytes`)                       |
| `content_hash` | TEXT     | sha256 of content; dedup helper                                |
| `status`       | TEXT     | `pending` → `live` → `stale` → `superseded` → `pruned`         |
| `mtime`        | INTEGER  | Source mtime (for `file_chunk`); 0 otherwise                   |
| `created_at`   | INTEGER  | Epoch ms                                                       |
| `updated_at`   | INTEGER  | Epoch ms                                                       |
| `metadata`     | TEXT     | JSON blob (token counts, tool name, line ranges, etc.)         |

### `edges` table

| Column      | Type | Notes                                                    |
| ----------- | ---- | -------------------------------------------------------- |
| `src_id`    | TEXT | FK → nodes                                               |
| `dst_id`    | TEXT | FK → nodes                                               |
| `kind`      | TEXT | `derived_from`, `references`, `summarizes`, `supersedes` |
| `created_at`| INT  | Epoch ms                                                 |

### `nodes_fts` (FTS5)

Mirrors `id` + `content` for keyword search.

### `nodes_vec` (sqlite-vec)

`(id, embedding BLOB)`; populated lazily by `embedding_indexer` walker.

### Status state machine

```
pending → live → stale → superseded → pruned
   ↓                          (walker triggers transitions)
  drop  ← filter walker decides keep vs. drop
```

- **`pending`**: just captured by hook; not yet triaged.
- **`live`**: filter walker accepted; available for retrieval.
- **`stale`**: source mtime changed OR newer node `supersedes` it.
- **`superseded`**: pointed at by a `supersedes` edge from a newer node.
- **`pruned`**: removed from FTS/vec indices; row kept for audit until retention horizon.

---

## 4. mcp-exec Wrapper Contract

memtree wraps the native tools that today emit large outputs straight to context. Each wrapper writes to the store and returns either a node ID + summary or the raw content within a budget.

### Wrapped tools (MCP server exposes)

- `memtree.read(path, lines?, budget_tokens?)` — wraps Read; chunks file into nodes by symbol or by 200-line windows; returns the requested slice; reuses existing node if `mtime` unchanged.
- `memtree.grep(pattern, path?, ...)` — wraps Grep; stores result set as a `tool_output` node + per-hit child `file_chunk` nodes for the lines hit.
- `memtree.bash(command, ...)` — wraps Bash; stores stdout/stderr as `tool_output`; returns truncated preview + node ID.

### Cache invalidation

- For `file_chunk` nodes: compare `mtime` on retrieval; if source file changed, mark old node `stale`, create new node, write `supersedes` edge old → new.
- For `tool_output` nodes: keep all (audit trail); dedupe by `content_hash` against existing nodes in same hour window.

### `memtree.compose(node_ids, budget_tokens, format)` — the surgical-recall tool

| Param           | Notes                                                                |
| --------------- | -------------------------------------------------------------------- |
| `node_ids`      | List of seed node IDs                                                |
| `budget_tokens` | Hard cap                                                             |
| `format`        | `raw` (concat content), `outline` (summaries only), `mixed` (default — summaries for distant nodes, raw for nearest) |

Algorithm:

1. Start with seeds.
2. Expand via `parent_id` + edges (depth cap 2 unless caller raises).
3. Pack greedily by relevance score until budget hit.
4. For overflow nodes, substitute their `summary` child if one exists; else `outline`.

Returns a single concatenated string + manifest of what was included/dropped.

---

## 5. Query / Access API

### MCP tools exposed for retrieval

- `memtree.search(query, mode?, limit?, filters?)` — default mode `hybrid` (RRF k=60 over keyword + semantic); fall back to `keyword` if Ollama unavailable.
- `memtree.neighbors(node_id, depth?, edge_kinds?)` — graph walk; depth cap **5**; default depth 1.
- `memtree.path_to_root(node_id)` — spine walk via `parent_id`.
- `memtree.recent(since?, kind?, limit?)` — time-series scan.
- `memtree.compose(...)` — see §4.

### Defaults

- Hybrid search uses **Reciprocal Rank Fusion**, `k=60`.
- Embeddings are **lazy**: a node gets embedded by the walker, not at write time. New nodes are keyword-searchable immediately; semantically searchable within seconds.
- `watch(query)` (live subscription) is **deferred** post-v1 — adds protocol complexity without obvious v1 use case.

---

## 6. Walkers (Background Routines)

Single-threaded coordinator runs walkers on a tick loop; each walker has its own cadence + idle threshold. SQLite WAL mode permits safe concurrent reads.

| Walker                  | Trigger                                                          | Action                                                                                                              |
| ----------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **`filter`**            | New node in `pending` (event-driven)                             | Drop if size < `filterMinSize`, exact-dedup by `content_hash`, or matches noise heuristic; else promote to `live`. |
| **`embedding_indexer`** | Idle ≥ `embeddingIdleMs` (default 5s) AND backlog > 0            | Batch-embed via Ollama (batch size 32); write to `nodes_vec`.                                                       |
| **`summarizer`**        | Subtree node count > `summarizerSubtreeThreshold` (default 25)   | Call Haiku 4.5; create `summary` node + `summarizes` edge.                                                          |
| **`dedupe`**            | Every 60s                                                        | Find near-duplicates by embedding cosine ≥ 0.97; merge → keep newest, mark old `superseded`.                        |
| **`staleness_marker`**  | Every 30s                                                        | Re-stat source files; mark `file_chunk` nodes `stale` if `mtime` advanced.                                          |
| **`pruner`**            | Every 5 min                                                      | Drop `stale` older than `staleHours`; drop `superseded` older than `supersededDays`.                                |

### Soft dependencies

| Dep                                  | Behavior when missing                                          |
| ------------------------------------ | -------------------------------------------------------------- |
| Ollama + `nomic-embed-text`          | Semantic/hybrid search → keyword-only; embedding walker no-ops |
| `ANTHROPIC_API_KEY` (for summarizer) | `summarizer` walker no-ops                                     |
| git CLI                              | Falls back to absolute workspace path for `<project-hash>`     |

Hard deps: Node 20+, bundled `better-sqlite3`, bundled `sqlite-vec`.

---

## 7. Capture Strategy (PostToolUse Hook)

memtree captures **all** native tool outputs for Read, Grep, Bash via a Claude Code `PostToolUse` hook. Captured data lands in `status=pending`; the `filter` walker triages.

Rationale (vs. allowlisting specific tool/path patterns at hook level): hook-level allowlisting requires tuning per-project and risks missing relevant context; the walker has more information (size, dedupe state, recent neighbors) to make a good keep/drop call. Trade-off: store grows faster pre-filter, and the filter walker must run frequently enough that `pending` doesn't pile up. Default `filterMinSize=50` bytes and `maxBytes=100000` per node bound the worst case.

Hook plumbing: `${CLAUDE_PLUGIN_ROOT}/mcp/dist/hooks/capture.js`. Writes via direct SQLite (WAL — same process model as walkers).

---

## 8. Packaging — Plugin + Skill + MCP

### Layout

```
memtree/
├── .claude-plugin/
│   └── plugin.json              # canonical manifest
├── skills/
│   └── using-memtree/
│       └── SKILL.md
├── mcp/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── server.ts
│       ├── store/               # sqlite + fts5 + sqlite-vec
│       ├── walkers/             # filter, embedding_indexer, summarizer, dedupe, staleness_marker, pruner
│       ├── hooks/               # PostToolUse capture
│       └── tools/               # mcp-exec wrappers + query API
└── README.md
```

### `.claude-plugin/plugin.json`

```json
{
  "name": "memtree",
  "description": "Tree/graph-based parallel context store with surgical recall via mcp-exec",
  "author": { "name": "Joe Black", "email": "joeblackwaslike@gmail.com" },
  "homepage": "https://github.com/joeblackwaslike/memtree",
  "repository": "https://github.com/joeblackwaslike/memtree",
  "license": "MIT",
  "mcpServers": {
    "memtree": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/mcp/dist/server.js"]
    }
  },
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Read|Grep|Bash",
        "hooks": [
          { "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/mcp/dist/hooks/capture.js" }
        ]
      }
    ]
  }
}
```

**Note:** `version` field is intentionally **omitted** — gives git-SHA versioning during active pre-1.0 development; every commit becomes a new version users can pull.

### Skill (`skills/using-memtree/SKILL.md`)

Short, retrieval-oriented. Activates when the agent is in a large codebase or long session.

> Use memtree's MCP tools instead of native Read/Grep/Bash when working in a large codebase or long session. Use `memtree.search` for recall, `memtree.compose` to assemble context within a token budget, `memtree.neighbors` to walk lateral relations. Prefer memtree over re-reading files you've already touched this session.

### Language: TypeScript

Per `joe-stack-preferences`: MCP servers, plugins, and tools default to TS. Bun/Node 20 runtime. `better-sqlite3` + `sqlite-vec` bundled via npm.

---

## 9. Future: VS Code Inspector

Deferred to a separate companion repo, **`memtree-vscode`**, after memtree v1 ships and schema stabilizes.

Scope (MVP, ~1–2 days):

- Read-only VS Code extension.
- Uses `vscode.TreeDataProvider` for the tree spine.
- Watches the SQLite WAL file for changes; re-queries on tick.
- Shows node kind, status, timestamp, content preview, neighbors.
- Optional graph view (later) via `vscode.WebviewPanel` + cytoscape.

Out of v1 scope; called out here so the schema is designed with external read-only consumers in mind (status column is human-readable, timestamps are epoch ms, content is plain text, edges table is queryable).

---

## 10. Open Questions / Risks

- **Hook latency.** PostToolUse runs synchronously; writing to SQLite is fast (≤5ms) but if walker workload causes WAL contention, latency could leak into tool calls. Mitigation: hook writes via a tiny `INSERT` then returns; walker handles indexing async.
- **Filter walker tuning.** `Capture-all + filter` means the filter walker is the gatekeeper of store cleanliness. Bad heuristics → store bloat. Plan: ship conservative defaults (size threshold + exact dedupe only), expose `filterMinSize` and a custom filter hook for users to extend.
- **`summarizer` cost.** Haiku 4.5 isn't free; large sessions could accumulate calls. Mitigation: only fires when subtree exceeds threshold; rate-limited; respects daily cap in config.
- **Embedding model drift.** If a user changes `embeddingModel` mid-project, old vectors are unusable. Mitigation: store model name in `metadata`; reject mixed-model search; offer one-shot re-embed.
- **Project-hash collisions.** sha256 truncated to 16 hex chars (~64 bits) — collision-resistant for any realistic project count.

---

## 11. Acceptance Criteria

A v1 build is "done" when:

1. Plugin installs via marketplace; MCP server boots; PostToolUse hook captures Read/Grep/Bash outputs.
2. `memtree.search` returns hybrid-ranked results across a populated store.
3. `memtree.compose(seeds, budget, format='mixed')` produces a context bundle within budget.
4. All six walkers (filter, embedding_indexer, summarizer, dedupe, staleness_marker, pruner) run on schedule; status transitions observable in the DB.
5. Server starts in <500ms cold; tool wrapper round-trip <50ms median for cached chunks.
6. Graceful degradation: missing Ollama → keyword search still works; missing `ANTHROPIC_API_KEY` → summarizer no-ops without crashing.
7. Bundled `using-memtree` skill activates and is discoverable by the agent.

---

## 12. Out of Scope (v1)

- Live subscriptions (`watch(query)`).
- Multi-machine sync.
- Web/VS Code UI.
- Replacing every native tool — memtree augments.
- User-facing query language beyond the MCP tools listed.
