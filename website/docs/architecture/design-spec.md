---
id: design-spec
title: Design Spec
sidebar_position: 2
---

# memtree — Design Spec

**Date:** 2026-05-17  
**Author:** Joe Black  
**Repository:** github.com/joeblackwaslike/memtree

---

## 1. Problem & Goals

LLM context windows are a scarce, expensive, write-once resource. Tool outputs (Read, Grep, Bash) flood the window with low-signal data that compounds across turns; the model must then carry that ballast through every subsequent inference. Compaction helps but is lossy and not deterministic.

**memtree** is an external, persistent, tree- and graph-shaped context store with surgical recall. In v1 there is one path into it:

1. **Memtree-backed tools** (`memtree.read`, `memtree.grep` in v1; `memtree.bash` deferred to v1.1) — independent MCP tools that implement equivalent behavior on top of `fs` / ripgrep, store the full output, and return only a budget-bounded slice. These are *not* bridges to Claude's native tools; they're separate tools that the agent should reach for **whenever available**, with native `Read`/`Grep` as the fallback for cases where a memtree-backed tool isn't appropriate.

Retrieval happens through MCP tools (`search`, `compose`, `neighbors`) and pulls only the bytes needed.

### Goals (v1)

- **Surgical recall.** Pull a tightly scoped slice of prior context instead of re-reading whole files.
- **Parallel context.** Live alongside the active conversation; capture transparently; survive across sessions.
- **Indexing (v1 subset).** Keyword (FTS5), tree (parent_id B-tree), and time-series (created_at).
- **Self-maintaining (v1 subset).** Filter, staleness, and pruner walkers keep the store from bloating.
- **Local-first.** No cloud dependency. v1 has zero soft external deps.

### Roadmap (v1.1+)

- **Passive capture via PostToolUse hook.** Hook fires on every native `Read`/`Grep`/`Bash`, writing to a Unix socket on the MCP server for background ingestion.
- **Semantic and hybrid search.** sqlite-vec + configurable embedding provider (Ollama/OpenAI); Reciprocal Rank Fusion over FTS + semantic.
- **Dedupe and summarization walkers.** Near-dup merge via cosine ≥ 0.97; Haiku 4.5 / GPT-4o-mini subtree summaries.
- **`memtree.bash`.** Routes through Claude Code's native `Bash` via `mcp-exec`, inheriting its permission prompts and sandbox.
- **Bundled hook binary.** Replaces `jq`/`socat`/`awk` system deps.

### Non-goals (v1)

- Multi-user / multi-machine sync.
- A VS Code or web UI (deferred — see §9).
- Replacing every native tool call.
- Passive capture of native tool calls — deferred to v1.1.
- Capturing Serena MCP outputs (ephemeral LSP queries with no recall value).

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
4. **Fallback** if not a git repo: `project-hash = sha256(absolute_workspace_path).slice(0, 16)`

Rationale: path-dependent by design — moving or re-cloning the repo yields a new hash and a fresh store. Including the first-commit SHA reduces collision risk between unrelated repos that share a path.

### Configuration

Global config at `~/.memtree/config.json`:

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

Per-project override at `<project_root>/.memtree/config.json`. Shallow-merged at server startup — top-level keys replace the corresponding global keys wholesale.

Precedence: per-project override > global > built-in defaults.

---

## 3. Node Schema & Relationships

memtree is a **tree-spined graph**: every node has exactly one `parent_id` (the spine), plus zero-or-more lateral edges in a separate `edges` table.

### `nodes` table

| Column | Type | Notes |
| ------ | ---- | ----- |
| `id` | TEXT PK | ULID (time-sortable) |
| `parent_id` | TEXT FK | NULL for roots; indexed |
| `kind` | TEXT | `session`, `file_chunk`, `tool_output`, `summary`, `note`, `observation` |
| `source_uri` | TEXT | e.g., `file:///path#myFunction`, `tool:Bash#sha256`; dedup key |
| `content` | TEXT | Raw bytes (capped by `capture.maxBytes`) |
| `content_hash` | TEXT | sha256 of content; dedup helper |
| `status` | TEXT | `pending` → `live` → `stale` → `superseded` → `pruned` |
| `mtime` | INTEGER | Source mtime (for `file_chunk`); 0 otherwise |
| `created_at` | INTEGER | Epoch ms |
| `updated_at` | INTEGER | Epoch ms |
| `truncated` | INTEGER | 1 if content was truncated at `capture.maxBytes` |
| `original_bytes` | INTEGER | Pre-truncation byte count |
| `metadata` | TEXT | JSON blob (token counts, tool name, line ranges, etc.) |

### `parent_id` semantics by kind

| Kind | Parent |
| ---- | ------ |
| `session` | NULL — sessions are tree roots |
| `file_chunk` | The file's root node (a `file_chunk` with `metadata.is_file_root=true`) |
| `tool_output` | The current `session` node |
| `summary` | The subtree root it summarizes |
| `note` | The current `session` node (unless caller provides explicit `parent_id`) |
| `observation` | The current `session` node |

### `edges` table

| Column | Type | Notes |
| ------ | ---- | ----- |
| `src_id` | TEXT | FK → nodes |
| `dst_id` | TEXT | FK → nodes |
| `kind` | TEXT | `derived_from`, `references`, `summarizes`, `supersedes`, `follows` |
| `created_at` | INT | Epoch ms |

### Status state machine

```
pending → live → stale → superseded → pruned
   ↓
  drop  ← filter walker decides keep vs. drop
```

- **`pending`**: just captured; not yet triaged
- **`live`**: filter walker accepted; available for retrieval
- **`stale`**: source mtime changed OR newer node supersedes it
- **`superseded`**: pointed at by a `supersedes` edge from a newer node
- **`pruned`**: removed from indices; row kept for audit until retention horizon

---

## 4. Memtree-backed Tool Contract

The memtree-backed retrieval tools are the **primary** mechanism for keeping raw outputs out of the window in v1. They are independent MCP replacement tools that implement equivalent behavior on top of `fs` and ripgrep, storing the full output before returning a bounded slice.

**Why memtree-backed tools rather than hook-based rewriting in v1.** The Claude Code hooks API does expose `PostToolUse.updatedToolOutput` — but v1 deliberately avoids it because:

1. Silently substituting a truncated result changes the contract mid-call with no signal to the agent.
2. Hook-based rewriting pushes nontrivial budget-policy logic into the hook hot path.
3. Explicit memtree-backed tools surface the budget decision in the schema (`budget_tokens` param), making the agent's plan legible.

### memtree_compose algorithm

1. Start with seed node IDs
2. BFS-expand via `parent_id` + `edges` (depth cap, default 2)
3. Score each candidate: `relevance = w_dist * (1/(1+dist)) + w_recency * decay(updated_at) + w_query * fts_rank(query?)`
   - Default weights: `w_dist=0.6`, `w_recency=0.3`, `w_query=0.1` (when query provided)
4. Pack greedily by descending score until `budget_tokens` is hit
5. Return content + manifest listing included/dropped/truncated nodes

### Path denylist

`memtree_read` and `memtree_grep` reject paths matching:

`.env*`, `.envrc`, `**/.ssh/**`, `**/.aws/credentials`, `**/.aws/config`, `**/.gnupg/**`, `**/.npmrc`, `**/.pypirc`, `**/.netrc`, `**/id_rsa*`, `**/id_ed25519*`, `**/*.pem`, `**/*.key`, `**/*.pfx`, `**/*.p12`, `**/service-account*.json`, `**/credentials.json`

Extended (not replaced) by `<project_root>/.memtree/path.deny`.

---

## 5. Query / Access API

### Retrieval tools

- `memtree_search(query, mode?, limit?, filters?)` — v1: only `mode='keyword'`; `mode='hybrid'`/`mode='semantic'` rejected with documented error
- `memtree_neighbors(node_id, depth?, edge_kinds?)` — graph walk; depth cap 5
- `memtree_path_to_root(node_id)` — spine walk via `parent_id`
- `memtree_recent(since?, kind?, limit?)` — time-series scan
- `memtree_compose(...)` — see §4

### Filters schema

```typescript
type Filters = {
  status?: NodeStatus[];
  kind?: NodeKind[];
  since?: number;      // epoch ms inclusive
  until?: number;      // epoch ms inclusive
  parent_id?: string;
  session_id?: string;
};
```

---

## 6. Walkers (Background Routines)

Everything runs in a **single Bun process**: MCP tool handlers and walker coordinator. SQLite WAL mode permits concurrent readers alongside the single writer. Walkers use `setInterval` callbacks.

| Walker | Trigger | Action |
| ------ | ------- | ------ |
| **filter** | New node in `pending` | Drop if size < `filterMinSize`, exact-dedup, or noise heuristic; else promote to `live` |
| **embedding_indexer** | Idle ≥ `embeddingIdleMs` AND backlog > 0 | Batch-embed via Ollama; write to `nodes_vec` |
| **summarizer** | Subtree > `summarizerSubtreeThreshold` | Call Haiku 4.5; create `summary` node + `summarizes` edge |
| **dedupe** | Every 60s | Merge near-duplicates (cosine ≥ 0.97); mark old `superseded` |
| **staleness_marker** | Every 30s | Re-stat source files; mark `file_chunk` nodes `stale` if mtime advanced |
| **pruner** | Every 5m | Drop `stale` older than `staleHours`; drop `superseded` older than `supersededDays` |

### Soft dependencies

| Dep | Behavior when missing |
| --- | --------------------- |
| Ollama + `nomic-embed-text` | Semantic/hybrid search → keyword-only; embedding walker no-ops |
| `ANTHROPIC_API_KEY` | `summarizer` walker no-ops |
| git CLI | Falls back to absolute workspace path for project hash |

---

## 7. Capture Strategy (PostToolUse Hook) — v1.1

> This entire section is v1.1. In v1, data enters the store only via memtree-backed tool handlers.

The `PostToolUse` hook is **passive indexing only** — it does not rewrite tool output. Its job is to make native tool outputs available for future `memtree_search` / `memtree_compose` calls.

### Security: capture-time redaction

The ingestion handler applies redaction **before** `INSERT`:

- **Command denylist (Bash)**: drop the whole node for `env`, `printenv`, and per-project denylist
- **Output-string redaction (Bash)**: replace in-place with `[REDACTED:<tag>]` — covers AWS keys, GitHub tokens, JWT bearer tokens, `OPENAI_API_KEY=`, `ANTHROPIC_API_KEY=`, and generic 32+ char hex/base64 blobs following secret-like context
- **Path denylist (Read/Grep)**: drop the whole node before INSERT for secret-file paths
- **Filesystem hardening**: `~/.memtree/<hash>/` at `0700`; `store.db` at `0600`

**Known-leaky surfaces (accepted v1 limitations):**

1. Bash subshell/wrapper evasion — regex-on-command-string misses `bash -c 'env'`, `(env)`, etc. Output-side regex redaction is the safety net.
2. Secrets inside `Read`/`Grep` content — path denylist covers secret files but not non-denylisted files containing accidentally pasted secrets.

---

## 8. Packaging — Plugin + Skill + MCP

### Repository layout

```
memtree/
├── .claude-plugin/
│   └── plugin.json         # canonical manifest
├── skills/
│   └── using-memtree/
│       └── SKILL.md
├── mcp/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── server.ts
│       ├── project-hash.ts
│       ├── store/           # sqlite + fts5 + sqlite-vec
│       ├── walkers/         # filter, staleness_marker, pruner
│       └── tools/           # memtree-backed read/grep + query API
└── README.md
```

### Plugin manifest

The plugin registers:
- `memtree` MCP server
- `mcp-exec` MCP server (sandboxed execution)
- 10 hooks (SessionStart, PreToolUse×4, PostToolUse×3, UserPromptSubmit, Stop)

All hook commands use `/usr/bin/env bun` (not hardcoded Homebrew paths) for cross-platform compatibility.

---

## 9. Future: VS Code Inspector

Deferred to a separate companion repo, **`memtree-vscode`**, after v1 ships and schema stabilizes.

Scope (MVP):
- Read-only VS Code extension
- `vscode.TreeDataProvider` for the tree spine
- Watches the SQLite WAL file for changes; re-queries on tick
- Node kind, status, timestamp, content preview, neighbors
- Optional graph view via `vscode.WebviewPanel` + cytoscape

---

## 10. Open Questions / Risks

- **Hook latency.** Socket-ingestion targets ~10–25ms p50; hook is fire-and-forget on failure
- **Filter walker tuning.** Ships conservative defaults; `filterMinSize` and custom filter hook are user-extensible
- **Redaction false negatives.** Regex-based; novel secret format may leak — test fixture guards known cases
- **Summarizer cost (v1.1+).** Rate-limited; respects daily cap in config
- **Embedding model drift (v1.1+).** `nodes_vec.embedding_model` per row; mixed-model search rejected; one-shot re-embed command available
- **Monorepo subprojects share a store** — intentional; scope via `parent_id`/`session_id` filters
- **Worktrees get separate stores** — intentional; symlink to share manually

---

## 11. Acceptance Criteria

### v1 ships

- Memtree-backed tools: `memtree_read` (tree-sitter + fallback), `memtree_grep`, `memtree_compose`
- Query API: `memtree_search` (keyword-only), `memtree_neighbors`, `memtree_path_to_root`, `memtree_recent`
- Walkers: `filter`, `staleness_marker`, `pruner`
- Provider interfaces: `EmbeddingProvider` and `SummarizerProvider` typed (no implementations)
- Bundled skill: `using-memtree`
- Prebuilt native deps for macOS arm64 + Linux x64/arm64

### v1 is "done" when

1. Plugin installs via marketplace; MCP server boots in &lt;500ms cold
2. `memtree_search(mode='keyword')` returns FTS-ranked results; `mode='hybrid'`/`mode='semantic'` are rejected with documented error
3. `memtree_compose` produces context within budget; manifest correctly reports included/dropped/truncated nodes
4. Three v1 walkers run on schedule; `pending → live → stale → pruned` transitions observable in DB
5. Memtree-backed tool round-trip &lt;50ms median for cached chunks
6. `memtree_read` rejects secret-file paths before any DB write

### Deferred to v1.1

- `embedding_indexer`, `summarizer`, `dedupe` walkers
- Semantic and hybrid search
- `memtree.bash` execution tool
- Bundled compiled hook binary

---

## 12. Out of Scope (v1)

- Live subscriptions (`watch(query)`)
- Multi-machine sync
- Web/VS Code UI
- Replacing every native tool — memtree augments
- User-facing query language beyond the MCP tools listed
