# ctx-tree — Design Spec

**Date:** 2026-05-17
**Status:** Draft (awaiting user approval before implementation plan)
**Author:** Joe Black
**Repository:** github.com/joeblackwaslike/ctx-tree

---

## 1. Problem & Goals

LLM context windows are a scarce, expensive, write-once resource. Tool outputs (Read, Grep, Bash) flood the window with low-signal data that compounds across turns; the model must then carry that ballast through every subsequent inference. Compaction helps but is lossy and not deterministic.

**ctx-tree** is an external, persistent, tree- and graph-shaped context store with surgical recall. In v1 there is one path into it:

1. **CtxTree-backed tools** (`ctx-tree.read`, `ctx-tree.grep` in v1; `ctx-tree.bash` deferred to v1.1) — independent MCP tools that implement equivalent behavior on top of `fs` / ripgrep, store the full output, and return only a budget-bounded slice. These are *not* bridges to Claude's native tools; they're separate tools that the agent should reach for **whenever available**, with native `Read`/`Grep` as the fallback for cases where a ctx-tree-backed tool isn't appropriate (e.g. interactive flows the model wants to see in full).

Retrieval happens through MCP tools (`search`, `compose`, `neighbors`) and pulls only the bytes needed.

### Goals (v1)

- **Surgical recall.** The agent should be able to pull a tightly scoped slice of prior context (a function body, three related observations) instead of re-reading whole files.
- **Parallel context.** Live alongside the active conversation; capture transparently; survive across sessions.
- **Indexing (v1 subset).** Keyword (FTS5), tree (parent_id B-tree), and time-series (created_at) — queryable individually or combined.
- **Self-maintaining (v1 subset).** Filter, staleness, and pruner walkers keep the store from bloating without user intervention.
- **Local-first.** No cloud dependency for the store. v1 has zero soft external deps (no embedding or summarization code paths).

### Roadmap (v1.1+)

- **Passive capture via PostToolUse hook.** A `sh`+`jq`+`socat` hook fires on every native `Read`/`Grep`/`Bash` call, writing the payload to a Unix socket on the MCP server for background ingestion. Guarantees indexing even when the agent forgets to use a ctx-tree-backed tool. v1.1 implements the hook in passive-capture-only mode; `updatedToolOutput` rewriting (transparent context budgeting) follows in v1.2+.
- **Semantic and hybrid search.** sqlite-vec + configurable embedding provider (Ollama/OpenAI); Reciprocal Rank Fusion over FTS + semantic.
- **Embedding and summarization provider abstraction.** Drop-in compatible with Ollama (LLAMA), OpenAI API, and Anthropic API (summarization only — Anthropic has no embeddings endpoint). Provider interface defined in v1 types; implementations in v1.1.
- **Dedupe and summarization walkers.** Near-dup merge via cosine ≥ 0.97; Haiku 4.5 / GPT-4o-mini subtree summaries.
- **`ctx-tree.bash`.** CtxTree-backed Bash equivalent. In-process execution routes through Claude Code's native `Bash` tool via `mcp-exec` (or equivalent SDK bridge), inheriting its permission prompts and sandbox surface rather than bypassing it. Passive-only (store-and-recall without execution) is the default; `trustedExecution: true` in config enables in-process invocation.
- **Bundled hook binary.** Small compiled binary that replaces the `jq`/`socat`/`awk` system deps for the PostToolUse hook.

### Non-goals (v1)

- Multi-user / multi-machine sync.
- A VS Code or web UI (deferred to companion project — see §9).
- Replacing every native tool call (the agent still uses Read directly when appropriate; ctx-tree augments, doesn't replace).
- **Passive capture of native tool calls** — deferred to v1.1. In v1 the agent must explicitly call ctx-tree-backed tools.
- **Capturing Serena MCP outputs.** Serena provides live LSP queries (find_symbol, get_symbols_overview, search_for_pattern) whose outputs are ephemeral — they always reflect the current AST and re-running them is fast. No recall value in storing them. Serena and ctx-tree are complementary: use Serena for live code navigation, ctx-tree for content recall and context budgeting.

---

## 2. Storage Backend

### Engine: SQLite

Single-file embedded DB with:

- **FTS5** virtual table for keyword search.
- **sqlite-vec** extension for cosine-similarity vector search.
- **B-tree index** on `(created_at, parent_id)` for time- and tree-range queries.
- **WAL mode** for safe concurrent reads from walkers + writes from hooks.

### Storage Location

`~/.ctx-tree/<project-hash>/store.db`

`<project-hash>` is computed at MCP-server startup:

1. Run `git rev-parse --show-toplevel` to get the git root.
2. Run `git rev-list --max-parents=0 HEAD` to get the first-commit SHA.
3. `project-hash = sha256(git_root_path + ":" + first_commit_sha).slice(0, 16)`
4. **Fallback** if not a git repo or either command fails: `project-hash = sha256(absolute_workspace_path).slice(0, 16)`.

The hash is cached in memory for the lifetime of the server process.

Rationale: path-dependent by design — moving or re-cloning the repo to a different absolute path yields a new hash and a fresh store. Including the first-commit SHA reduces collision risk between unrelated repos that happen to share a path. If clone-stable IDs are needed later, swap `git_root_path` for the canonical remote URL; this is deferred because it's brittle for repos without a remote.

### Sidecar config: global + per-project override

Global config at `~/.ctx-tree/config.json`:

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

Per-project override at `<project_root>/.ctx-tree/config.json` (repo-local, version-controllable). The file is **shallow-merged into the global config** at server startup — top-level keys in the per-project file replace the corresponding global keys wholesale (not deep-merged), so a project that overrides `capture` must restate the full `capture` block. This rule keeps merge semantics predictable and easy to debug.

Per-project paths used by §7 redaction (`bash.deny`, `path.deny`) live alongside it: `<project_root>/.ctx-tree/bash.deny`, `<project_root>/.ctx-tree/path.deny`. `<project_root>/.ctx-tree/` should be added to `.gitignore` by convention if the project doesn't want config tracked, but is **not** auto-gitignored by ctx-tree.

Precedence at runtime: per-project override > global > built-in defaults.

---

## 3. Node Schema & Relationships

ctx-tree is a **tree-spined graph**: every node has exactly one `parent_id` (the spine), plus zero-or-more lateral edges in a separate `edges` table.

### `nodes` table

| Column         | Type     | Notes                                                          |
| -------------- | -------- | -------------------------------------------------------------- |
| `id`           | TEXT PK  | ULID (time-sortable)                                           |
| `parent_id`    | TEXT FK  | NULL for roots; indexed                                        |
| `kind`         | TEXT     | `session`, `file_chunk`, `tool_output`, `summary`, `note`, `observation`  |
| `source_uri`   | TEXT     | e.g., `file:///path#myFunction` (tree-sitter), `file:///path#L50-200` (window), `tool:Bash#sha256`; dedup key     |
| `content`      | TEXT     | Raw bytes (capped by `capture.maxBytes`)                       |
| `content_hash` | TEXT     | sha256 of content; dedup helper                                |
| `status`       | TEXT     | `pending` → `live` → `stale` → `superseded` → `pruned`         |
| `mtime`        | INTEGER  | Source mtime (for `file_chunk`); 0 otherwise                   |
| `created_at`   | INTEGER  | Epoch ms                                                       |
| `updated_at`   | INTEGER  | Epoch ms                                                       |
| `truncated`    | INTEGER  | 1 if content was truncated at `capture.maxBytes`; 0 otherwise  |
| `original_bytes`| INTEGER | Pre-truncation byte count (for callers deciding whether to re-fetch) |
| `metadata`     | TEXT     | JSON blob (token counts, tool name, line ranges, etc.)         |

### `parent_id` semantics by kind

The tree spine is the primary navigation surface, so every kind has a deterministic parent:

| Kind          | Parent                                                                                  |
| ------------- | --------------------------------------------------------------------------------------- |
| `session`     | `NULL` — sessions are tree roots. One node per Claude Code session, created lazily by the ingestion handler on the first capture in that session. Identified via `metadata.session_id` (from the hook payload's `session_id` field). |
| `file_chunk`  | The file's "file root" node (a `file_chunk` with `metadata.is_file_root=true` and the file's full path in `source_uri`). Symbol- and window-level chunks under the same file all share this single root as `parent_id`, so a flat fan-out per file keeps `compose`'s expansion predictable. The file root itself has `parent_id = NULL` (or the current `session` node, if the chunk was captured incidentally to a tool call — see `metadata.captured_by_session_id`). |
| `tool_output` | The current `session` node — the conversation turn that triggered the tool call.       |
| `summary`     | The subtree root it summarizes (also pointed at by a `summarizes` edge for explicit traversal). |
| `note`        | The current `session` node, unless the caller provides an explicit `parent_id`.        |
| `observation` | The current `session` node.                                                             |

`compose` and `neighbors` walk this spine first, then fan out via `edges`. Keeping `session` as the root for tool-derived content gives a natural "what happened this conversation" subtree and a clean home for `recent` queries.

### `edges` table

| Column      | Type | Notes                                                    |
| ----------- | ---- | -------------------------------------------------------- |
| `src_id`    | TEXT | FK → nodes                                               |
| `dst_id`    | TEXT | FK → nodes                                               |
| `kind`      | TEXT | `derived_from`, `references`, `summarizes`, `supersedes` |
| `created_at`| INT  | Epoch ms                                                 |

### `nodes_fts` (FTS5)

Mirrors `id` + `content` for keyword search. Kept in sync by `AFTER INSERT`, `AFTER UPDATE`, and `AFTER DELETE` triggers on `nodes` so callers never touch it manually.

### `nodes_vec` (sqlite-vec)

`(id, embedding BLOB, embedding_model TEXT, embedding_dim INTEGER, embedded_at INTEGER)`; populated lazily by `embedding_indexer` walker. Model name + dim are stored per-row so a mid-project embedding-model change is detected at query time — mixed-model searches are rejected with a clear error rather than returning silently bad results.

### Default retrieval filter

All MCP-exposed retrieval queries (`search`, `neighbors`, `path_to_root`, `recent`, `compose`) default to `WHERE status = 'live'`. Callers can opt into other statuses explicitly (e.g. for auditing or debugging), but the default is "what's currently useful."

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

## 4. CtxTree-backed Tool Contract

The ctx-tree-backed retrieval tools are the **primary** mechanism for keeping raw outputs out of the window in v1. They are **not** bridges to Claude's built-in Read/Grep — there is no public bridge to native tools. They are independent MCP replacement tools that implement equivalent behavior on top of the filesystem (Node `fs`) and ripgrep, and they store the full output before returning a bounded slice.

**Why ctx-tree-backed tools rather than hook-based rewriting in v1.** The Claude Code hooks API (verified against the `working-with-claude-code` reference, 2026-05) *does* expose a `PostToolUse.updatedToolOutput` field that can replace the tool result before Claude consumes it — an earlier draft of this spec incorrectly claimed otherwise. So in principle a hook could intercept any native `Read`/`Grep`/`Bash` and substitute a ctx-tree-budgeted slice. v1 deliberately does **not** take this path because:

1. The hook would need to decide token-budget policy synchronously, in a shell pipeline, on *every* matched tool call — pushing nontrivial logic into the hook hot path.
2. Silently substituting a truncated result for a tool the agent expected to return full output changes the contract mid-call; the agent has no signal that the substitution happened, and downstream tools that ingest the result (e.g. a follow-up `Bash` that pipes it) will see truncated bytes.
3. Explicit ctx-tree-backed tools surface the budget decision in the schema (`budget_tokens` param), so the agent's plan is legible from outside.

Hook-based rewriting is on the v1.1 roadmap as an opt-in mode for users who would rather pay the substitution-surprise cost than train the agent to prefer `ctx-tree.read`.

So the v1 contract is: each ctx-tree-backed tool writes the full output to the store and returns either a node ID + bounded preview, or the raw content within a caller-specified token budget. The agent should prefer ctx-tree-backed tools when available, with native `Read`/`Grep` as fallback. Passive `PostToolUse` capture (§7) covers the gap when the agent uses native tools — those outputs become available for future-turn `ctx-tree.search` / `ctx-tree.compose`, but the current turn is not rewritten.

### CtxTree-backed tools (MCP server exposes)

- `ctx-tree.read(path, lines?, budget_tokens?)` — reads via Node `fs`; **chunks the file by symbol via tree-sitter** when a parser is available, falling back to 200-line windows otherwise; returns the requested slice; reuses existing node if `mtime` unchanged. v1 ships tree-sitter parsers for TypeScript/TSX, JavaScript/JSX, Python, Rust, Go, Bash, and JSON/TOML/YAML. Other languages get window-based chunking with a `metadata.chunking="window"` marker so the eval harness can distinguish symbol-aware from fallback hits. Adding a parser later requires no schema change — affected files are re-chunked next time their `mtime` advances.
- `ctx-tree.grep(pattern, path?, ...)` — shells out to system `rg` (ripgrep); stores result set as a `tool_output` node + per-hit child `file_chunk` nodes for the lines hit.
- `ctx-tree.bash(command, ...)` — **deferred to v1.1.** In v1 there is no `ctx-tree.bash` tool. When added in v1.1, in-process execution routes through Claude Code's native `Bash` tool via `mcp-exec`, inheriting its permission prompts and sandbox rather than bypassing it.

### Path denylist (v1)

`ctx-tree.read` and `ctx-tree.grep` enforce a path denylist **before any DB write** — this is a v1 feature, not deferred to the v1.1 hook. Paths matching any of the following are rejected with an error:

`.env*`, `.envrc`, `**/.ssh/**`, `**/.aws/credentials`, `**/.aws/config`, `**/.gnupg/**`, `**/.npmrc`, `**/.pypirc`, `**/.netrc`, `**/id_rsa*`, `**/id_ed25519*`, `**/*.pem`, `**/*.key`, `**/*.pfx`, `**/*.p12`, `**/service-account*.json`, `**/credentials.json`

The default list is extended (not replaced) by an optional per-project `<project_root>/.ctx-tree/path.deny` glob file. The same denylist applies to hook-based Read/Grep ingestion in v1.1 (§7).

Note: the Bash output-string redaction (AWS keys, GitHub tokens, JWTs, etc.) is **not** applied to `ctx-tree.read` / `ctx-tree.grep` content in v1 — only path-based rejection. Applying content-level regex to Read/Grep outputs is under investigation for v1.1 (false-positive rate on legitimate code is the open question).

### Cache invalidation

- For `file_chunk` nodes: compare `mtime` on retrieval; if source file changed, mark old node `stale`, create new node, write `supersedes` edge **newer → older** (the new node points back at what it replaces). This matches §3's definition of `superseded`: "pointed at by a `supersedes` edge from a newer node."
- For `tool_output` nodes: keep all (audit trail); dedupe by `content_hash` against existing nodes in the same hour window.

### `ctx-tree.compose(node_ids, budget_tokens, format?, query?)` — the surgical-recall tool

| Param           | Notes                                                                |
| --------------- | -------------------------------------------------------------------- |
| `node_ids`      | List of seed node IDs                                                |
| `budget_tokens` | Hard cap                                                             |
| `format`        | v1: `raw` (concat content, default) or `outline` (titles + previews). `mixed` is **deferred to v1.1** because it relies on summary children that the v1.1 `summarizer` walker will produce — there are no summary nodes in v1. |
| `query`         | Optional — when provided, rerank the candidate set by FTS relevance against the query in addition to graph distance. |

Algorithm:

1. Start with seeds.
2. Expand via `parent_id` + `edges` (depth cap 2 unless caller raises).
3. Score each candidate `c` by `relevance(c) = w_dist * (1 / (1 + graph_distance(c, nearest_seed))) + w_recency * recency_decay(c.updated_at) + w_query * fts_rank(c, query?)`. v1 defaults: `w_dist=0.6`, `w_recency=0.3`, `w_query=0.1` when `query` is provided; `w_dist=0.7`, `w_recency=0.3`, `w_query=0` otherwise. `recency_decay` is `exp(-age_hours / 24)`.
4. Pack greedily by descending score until `budget_tokens` is hit.
5. For overflow nodes, substitute their `summary` child if one exists (v1.1+) — in v1 they are simply dropped and named in the manifest.

Returns a single concatenated string + manifest listing included node IDs, dropped node IDs (with reason: `over_budget`, `superseded`, `pruned`), and any truncated nodes (per `nodes.truncated` flag) so the caller knows whether to re-fetch.

---

## 5. Query / Access API

### MCP tools exposed for retrieval

- `ctx-tree.search(query, mode?, limit?, filters?)` — **v1: only `mode='keyword'` is accepted.** `mode='hybrid'` and `mode='semantic'` are rejected at the tool-schema level with a clear error (`"semantic search requires v1.1 — only mode='keyword' is supported in v1"`) rather than silently falling back, because v1 ships zero embedding code paths. v1.1 introduces hybrid as default with RRF k=60 over keyword + semantic.
- `ctx-tree.neighbors(node_id, depth?, edge_kinds?)` — graph walk; depth cap **5**; default depth 1.
- `ctx-tree.path_to_root(node_id)` — spine walk via `parent_id`.
- `ctx-tree.recent(since?, kind?, limit?)` — time-series scan.
- `ctx-tree.compose(...)` — see §4.

### `filters?` schema (v1)

`ctx-tree.search`, `ctx-tree.recent`, and `ctx-tree.neighbors` accept the same `filters` object:

```ts
type Filters = {
  status?: ("pending" | "live" | "stale" | "superseded" | "pruned")[];  // default ["live"]
  kind?: ("session" | "file_chunk" | "tool_output" | "summary" | "note" | "observation")[];
  since?: number;     // epoch ms inclusive
  until?: number;     // epoch ms inclusive
  parent_id?: string; // restrict to children of this node
  session_id?: string; // restrict to a specific session subtree
};
```

JSON-path / metadata filters are **deferred to v1.1** — they need their own indexing strategy on the `metadata` JSON column to stay fast, and FTS + the columns above cover the v1 surface adequately.

### Defaults

- Embeddings (v1.1+) are **lazy**: a node gets embedded by the walker, not at write time. New nodes are keyword-searchable immediately; semantically searchable within seconds once v1.1 lands.
- `watch(query)` (live subscription) is **deferred** post-v1 — adds protocol complexity without obvious v1 use case.

---

## 6. Walkers (Background Routines)

### Process model

Everything runs in a **single Node process**: the MCP tool handlers, the Unix-socket ingestion handler, and the walker coordinator. SQLite WAL mode permits multiple concurrent readers alongside the single writer. Within the process:

- **Event loop, not threads.** Walkers are scheduled as `setInterval`/`setImmediate` callbacks. A walker that needs to do CPU-bound work (future: re-embedding, summarization) yields between batches so MCP tool requests and socket ingestion can interleave.
- **Bounded ingestion queue.** Socket ingestion writes land in an in-memory ring buffer (default 1,000 entries) consumed by a prepared-statement `INSERT` loop. If the buffer fills (server pinned), excess writes are **dropped with a stderr warning** rather than back-pressuring the hook — the hook is fire-and-forget by design (§7) and must never block tool calls.
- **No worker threads in v1.** If the v1.1 summarizer needs them, that's the right time to add them.

Walker coordinator runs on a tick loop; each walker has its own cadence + idle threshold.

| Walker                  | Trigger                                                          | Action                                                                                                              |
| ----------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **`filter`**            | New node in `pending` (event-driven)                             | Drop if size < `filterMinSize`, exact-dedup by `content_hash`, or matches noise heuristic; else promote to `live`. Target: **p95 `pending → live` < 100ms**. Fast path: the ingestion handler runs the cheap filter checks (size, exact-dedup, simple noise heuristics) synchronously and inserts the node directly as `live` when they pass. Only nodes that need expensive checks (future: embedding-aware similarity dedupe) hit the `pending` queue. This keeps "just-captured node is immediately searchable" the common case. |
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

Hard deps (v1): Node 20+, bundled `better-sqlite3`, bundled `sqlite-vec`, system `rg` (ripgrep) ≥13. System dep checked at server startup (see §8). (`jq` ≥1.6, `socat` ≥1.7, `awk` are v1.1-only hard deps, required by the PostToolUse capture hook.)

---

## 7. Capture Strategy (PostToolUse Hook) — v1.1

> **This entire section is v1.1.** In v1, there is no PostToolUse hook and no ingestion socket. Data enters the store only via the ctx-tree-backed tool handlers (`ctx-tree.read`, `ctx-tree.grep`). The hook design below is preserved here for v1.1 implementation; see `docs/superpowers/plans/2026-05-17-ctx-tree-v1.1.md`.

The `PostToolUse` hook is **passive indexing only** — it does *not* rewrite tool output (that's v1.2+ via `updatedToolOutput`). Its job is to make native tool outputs available for *future* `ctx-tree.search` / `ctx-tree.compose` calls. Captured data either lands in `status=pending` for walker triage, or — via the cheap-filter fast path (§6) — directly as `status=live`.

Hook-level capture is allowlisted at the matcher (`Read|Grep|Bash`) but otherwise greedy: filtering happens in-walker, where size, dedupe state, and recent neighbors are all available. Default `filterMinSize=50` bytes and `maxBytes=100000` per node bound the worst case.

### Ingestion path: hook → MCP server over Unix socket

The hook does **not** open SQLite directly. A ~80–150ms Node cold start plus `better-sqlite3` load plus WAL handshake on every `Read`/`Grep`/`Bash` would be a tax the agent feels in every turn. Instead:

1. The MCP server, already running for the session, listens on a Unix socket at `~/.ctx-tree/<project-hash>/ingest.sock` (mode `0600`). The server also writes a `<git_root_or_cwd>\t<project-hash>` line to a shared `~/.ctx-tree/projects.tsv` index at startup, keyed by absolute path, so the hook can resolve `cwd → project-hash` without invoking git.
2. The hook is a tiny script that resolves the project hash from the `cwd` field in the hook payload by walking up the directory tree until it finds a match in `~/.ctx-tree/projects.tsv` (or, equivalently, until a `~/.ctx-tree/<hash>/ingest.sock` exists for an ancestor). It then JSON-encodes the normalized payload `{ tool, input, response, exit, cwd, session_id, ts }` and writes one line to the matching socket. No DB handle, no walker contention. The earlier "single global active-hash file" design (a single `~/.ctx-tree/.active-project-hash`) was broken under concurrent sessions in different projects — it raced and could pipe one project's output into another project's store.
3. The server's ingestion handler does the redacted `INSERT` via a prepared statement (~1ms) and acks. The cheap-filter fast path (§6) lets most rows skip `pending` and land directly as `live`. Any failure — socket missing, server crashed, EAGAIN — is logged to stderr and silently dropped. ctx-tree must never block tool calls.

Realistic hook overhead: **~10–25ms** end-to-end including the socket round-trip. This stays under the noise floor of most tool calls. The earlier ≤5ms claim was wrong — it omitted Node startup. The socket design dodges Node startup entirely because the hook itself is a `sh` + `jq` + `awk` + `socat` shell script (`mcp/hooks/capture.sh`, see §8) — no Node process. The upper-end estimate covers the cwd-walk-up `awk` calls (usually ≤5 ancestor levels) added to fix the multi-project routing bug. `jq`, `awk`, and `socat` are v1.1-only hard deps (added with the PostToolUse hook); `rg` is the only v1 system dep. A bundled compiled binary that subsumes the whole shell pipeline is on the v1.1+ roadmap.

### Security: capture-time redaction

`Capture-all` is fine for Read/Grep but dangerous for Bash, which can pipe `env`, `printenv`, `aws sts get-caller-identity`, `gh auth token`, etc. Filtering after the fact is too late — the secret already landed in the row, the FTS index, and (eventually) the embedding.

So the ingestion handler applies redaction **before** `INSERT`:

- **Command denylist (Bash)** (drop the whole node): `env`, `printenv`, any binary listed in a per-project denylist file at `~/.ctx-tree/<project-hash>/bash.deny` (one regex per line).
- **Output-string redaction (Bash)** (replace in-place with `[REDACTED:<tag>]`): regex set for AWS access keys (`AKIA…`, `ASIA…`), GitHub tokens (`ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_…`), JWT bearer tokens, `AWS_SECRET_…=`, `OPENAI_API_KEY=`, `ANTHROPIC_API_KEY=`, and generic 32+ char hex/base64 blobs following a `secret`/`token`/`password`/`key=` lexical context.
- **Path denylist (Read/Grep)** (drop the whole node before INSERT): file path matches any of `.env*`, `.envrc`, `**/.ssh/**`, `**/.aws/credentials`, `**/.aws/config`, `**/.gnupg/**`, `**/.npmrc`, `**/.pypirc`, `**/.netrc`, `**/id_rsa*`, `**/id_ed25519*`, `**/*.pem`, `**/*.key`, `**/*.pfx`, `**/*.p12`, `**/service-account*.json`, `**/credentials.json`. The default list is **appended-to** (not overridden) by an optional per-project `~/.ctx-tree/<project-hash>/path.deny` glob file. Gitignored paths are captured but flagged in `metadata.gitignored=true` — gitignored ≠ secret, but a useful signal for the filter walker.
- **Per-project opt-out**: a project can set `capture.bash = false` (or `capture.read = false` / `capture.grep = false`) in its sidecar config to disable that capture path entirely.
- **Filesystem hardening**: `~/.ctx-tree/<project-hash>/` created at `0700`; `store.db` and `ingest.sock` at `0600`.

**Known-leaky surfaces (accepted v1 limitations, documented for users):**

1. **Bash subshell / wrapper evasion.** The command denylist is regex-on-command-string. It will not catch `bash -c 'env'`, `(env)`, `sh -c "printenv"`, `command env`, here-docs that exec a denied binary, or arbitrary interpreter shenanigans. v1 leans on the **output-side redaction set** (the regex set for AWS keys, GitHub tokens, JWTs, `KEY=value` lines, etc.) as the safety net — that path catches the resulting secret strings regardless of which shell construct produced them. The full-node drop on command-name match is a belt-and-suspenders cheap pre-filter, not the primary defense.
2. **Secrets inside `Read`/`Grep` content.** Both v1 tool handlers and v1.1 hook ingestion drop Read/Grep on *secret-file paths* (the `path.deny` list — see §4 "Path denylist"). However, neither v1 nor v1.1 applies the Bash-output regex set to the *content* of non-denylisted Read/Grep outputs. So `Read ~/notes.md` where a user pasted `OPENAI_API_KEY=sk-…` into a note file will land the secret in the store. Accepted limitation; extending output-string redaction to Read/Grep content is on the v1.1 list (the open question is false-positive rate on legitimate code that contains key-looking strings).

The redaction rules ship as a versioned module so users can audit and extend them. v1 ships with the rules above plus a test fixture of known-leaky outputs (Bash output strings and secret-file paths via Read/Grep) that must all redact-or-drop to clean state — see §11.

---

## 8. Packaging — Plugin + Skill + MCP

### Layout

```
ctx-tree/
├── .claude-plugin/
│   └── plugin.json              # canonical manifest
├── skills/
│   └── using-ctx-tree/
│       └── SKILL.md
├── mcp/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── server.ts
│       ├── project-hash.ts      # git-based project hash (no projects.tsv in v1)
│       ├── store/               # sqlite + fts5 + sqlite-vec
│       ├── walkers/             # v1: filter, staleness_marker, pruner
│       └── tools/               # ctx-tree-backed read/grep + query API
└── README.md
```

> **v1.1 addition:** `mcp/hooks/capture.sh` and `mcp/src/ingest.ts` are added in v1.1 alongside the PostToolUse hook. The root `package.json` adds Bun workspace config so all commands run from the repo root without `cd mcp`.

### `.claude-plugin/plugin.json`

```json
{
  "name": "ctx-tree",
  "description": "Tree/graph-based parallel context store with surgical recall via mcp-exec",
  "author": { "name": "Joe Black", "email": "joeblackwaslike@gmail.com" },
  "homepage": "https://github.com/joeblackwaslike/ctx-tree",
  "repository": "https://github.com/joeblackwaslike/ctx-tree",
  "license": "MIT",
  "mcpServers": {
    "ctx-tree": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/mcp/dist/server.js"],
      "env": { "CTX_TREE_CWD": "${workspaceFolder}" }
    }
  }
}
```

> **v1.1 addition:** The `hooks` section below (PostToolUse → shell script `capture.sh`, **not** a Node process) is added in v1.1. See §7.
>
> ```json
> "hooks": {
>   "PostToolUse": [
>     { "matcher": "Read|Grep|Bash", "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/mcp/hooks/capture.sh" }] }
>   ]
> }
> ```

**Note:** `version` field is intentionally **omitted** — gives git-SHA versioning during active pre-1.0 development; every commit becomes a new version users can pull.

### Hook script (`mcp/hooks/capture.sh`) — v1.1

> **Deferred to v1.1.** The full hook script design (cwd-walk-up project routing via `projects.tsv`, `jq` + `socat` pipeline, per-tool payload normalization, epoch-ms timestamp, fire-and-forget socket write) is preserved in §7 for v1.1 implementation. See `docs/superpowers/plans/2026-05-17-ctx-tree-v1.1.md`.

### Skill (`skills/using-ctx-tree/SKILL.md`)

Short, retrieval-oriented. Activates when the agent is in a large codebase or long session.

> Use ctx-tree's MCP tools instead of native Read/Grep when working in a large codebase or long session. Use `ctx-tree.read` to read files with symbol-level chunking and mtime caching. Use `ctx-tree.search` for recall, `ctx-tree.compose` to assemble context within a token budget, `ctx-tree.neighbors` to walk lateral relations. Prefer ctx-tree over re-reading files you've already touched this session.
>
> **Serena vs ctx-tree:** Use Serena (`find_symbol`, `get_symbols_overview`, `search_for_pattern`) for live code navigation — cross-references, go-to-definition, symbol rename. Use ctx-tree for content recall and context budgeting across turns and sessions. They are complementary tools.

### Language: TypeScript

Per `joe-stack-preferences`: MCP servers, plugins, and tools default to TS. Bun/Node 20 runtime. `better-sqlite3` + `sqlite-vec` bundled via npm.

### Native dependencies

Both `better-sqlite3` and `sqlite-vec` ship native binaries. The marketplace install flow does **not** run `npm install`, so the plugin must arrive with everything resolved.

v1 ships prebuilt binaries for the three platforms users actually have:

- macOS `arm64` (M-series)
- Linux `x64`
- Linux `arm64`

Strategy: a `mcp/scripts/prepare-release.sh` script runs during release (driven by `gh release create`) and, for each target triple, fetches the prebuilt binary via `prebuild-install` for `better-sqlite3` and the matching `sqlite-vec` release artifact. The resulting archives are **uploaded to the GitHub release via `gh release upload`** — not committed to the repo — keeping the git history clean.

At first run, a small `mcp/scripts/postinstall.ts` resolves `process.platform`/`process.arch` against the current plugin version's release, downloads the matching archive into `mcp/native/<platform>-<arch>/` (gitignored), verifies a SHA-256 checksum shipped alongside the release, and caches it. The server short-circuits the download on subsequent starts if the cache is populated. For air-gapped or offline installs, the same archives can be dropped into `mcp/native/<platform>-<arch>/` manually.

This trades a one-time download on first install for the repo-size win — the alternative (committing three binary archives per release) bloats the plugin source materially over the lifetime of the project.

System hard dep for v1: only `rg` (ripgrep ≥13). The server probes for it at startup and logs `missing system dep: rg — install via brew install ripgrep` and exits if absent. (`jq` ≥1.6 and `socat` ≥1.7 become hard deps in v1.1 when the PostToolUse capture hook ships; a tiny compiled binary that subsumes the whole `jq`+`socat` pipeline is on the v1.1+ roadmap to eliminate those system deps too.)

Other platforms (Windows, Linux `x86`, BSDs) are out of v1 scope. The server logs a clear `unsupported platform: <triple>` error and exits.

---

## 9. Future: VS Code Inspector

Deferred to a separate companion repo, **`ctx-tree-vscode`**, after ctx-tree v1 ships and schema stabilizes.

Scope (MVP, ~1–2 days):

- Read-only VS Code extension.
- Uses `vscode.TreeDataProvider` for the tree spine.
- Watches the SQLite WAL file for changes; re-queries on tick.
- Shows node kind, status, timestamp, content preview, neighbors.
- Optional graph view (later) via `vscode.WebviewPanel` + cytoscape.

Out of v1 scope; called out here so the schema is designed with external read-only consumers in mind (status column is human-readable, timestamps are epoch ms, content is plain text, edges table is queryable).

---

## 10. Open Questions / Risks

- **Hook latency.** `PostToolUse` runs synchronously. The socket-ingestion design in §7 targets ~10–25ms p50, with a p95 <40ms gate in the eval harness. A slow socket write (server pinned by walker, OS scheduler hiccup) could leak into tool calls. Mitigation: hook is fire-and-forget — any failure is logged and dropped, never retried in-line.
- **Filter walker tuning.** `Capture-all + filter` means the filter walker is the gatekeeper of store cleanliness. Bad heuristics → store bloat. Plan: ship conservative defaults (size threshold + exact dedupe only), expose `filterMinSize` and a custom filter hook for users to extend.
- **Redaction false negatives.** Hook-time redaction (§7) is regex-based — a novel secret format will leak. Mitigation: ship a known-leaky-output test fixture in the eval harness; bias toward dropping the whole node when *any* denylist regex matches the command itself.
- **`summarizer` cost (v1.1+).** Haiku 4.5 isn't free; large sessions could accumulate calls. Deferred from v1; when added, only fires when subtree exceeds threshold; rate-limited; respects daily cap in config.
- **Embedding model drift (v1.1+).** Changing `embeddingModel` mid-project makes existing vectors unusable. Mitigation lives in the schema: `nodes_vec.embedding_model` + `embedding_dim` per row (§3); mixed-model search is rejected at query time; users get a one-shot re-embed command.
- **Project-hash collisions.** sha256 truncated to 16 hex chars (~64 bits) — collision-resistant for any realistic project count. Path-dependent by design (see §2).
- **Monorepo subprojects share a store.** §2's hash is `(git_root, first_commit_sha)`, so all subprojects of a monorepo resolve to the same `<project-hash>` and share one store. Intentional — it's the same repo. Callers can scope queries to a subdirectory via the `parent_id` / `session_id` filters (§5) or via `metadata.cwd` matches. Splitting per-subproject would fragment context across walls the agent reasons over anyway.
- **Worktrees get separate stores.** `git rev-parse --show-toplevel` returns the worktree path, so two worktrees of the same repo on disk produce two different `<project-hash>` values and two independent stores. Intentional for agentic work where worktrees represent in-flight branches and you want each branch's captured context isolated. Users who want a worktree to share a parent's store can symlink `~/.ctx-tree/<worktree-hash>` → `~/.ctx-tree/<main-hash>` manually; v1 does not auto-detect this.
- **Bash command denylist is not exhaustive (see §7 "Known-leaky surfaces").** Regex-on-command-string misses subshells, `bash -c`, `command env`, etc. v1 documents this and leans on output-side regex redaction as the safety net. Closing the gap fully needs a shell parser or sandboxed-exec strategy that's out of v1 scope.
- **`ctx-tree.bash` execution surface (v1.1+).** Drop reason from v1: naively executing shell via `child_process` bypasses Claude Code's Bash permission/policy surface. v1.1 implementation routes through Claude Code's native `Bash` tool via `mcp-exec`, inheriting its permission prompts and sandbox — no bypass. Passive-only (store-and-recall, no execution) is the default; `trustedExecution: true` in config enables in-process invocation for trusted environments.
- **System-dep surface (v1.1+).** `jq`/`socat`/`rg` are standard on macOS+Linux but still extra friction. v1.1 ships a small compiled hook binary that removes them.

---

## 11. Acceptance Criteria

v1 narrows the surface vs. earlier drafts. The embedding indexer, summarizer, and dedupe walkers — and therefore semantic and hybrid search — are deferred to v1.1. They're the riskiest pieces (model drift, API cost, false-merge risk on near-duplicates), and FTS-only retrieval is more than enough to validate the rest of the architecture.

### v1 ships

- **CtxTree-backed tools**: `ctx-tree.read` (tree-sitter symbol chunking + 200-line fallback; path denylist enforced at call time), `ctx-tree.grep`, `ctx-tree.compose` (formats `raw` and `outline`; `mixed` deferred — depends on v1.1 summarizer). `ctx-tree.bash` deferred — see §1 roadmap and §10.
- **Query API**: `ctx-tree.search` (`mode='keyword'` only — `hybrid`/`semantic` rejected at schema in v1), `ctx-tree.neighbors`, `ctx-tree.path_to_root`, `ctx-tree.recent`. All retrieval tools accept the v1 `filters` schema (`status`, `kind`, `since`/`until`, `parent_id`, `session_id`).
- **Walkers**: `filter` (batch processing, startup sweep), `staleness_marker`, `pruner`. All walkers have error boundaries; coordinator runs a startup sweep of pre-existing `pending` rows.
- **Provider interfaces**: `EmbeddingProvider` and `SummarizerProvider` defined in types (no implementations in v1 — v1.1 adds Ollama/OpenAI/Anthropic adapters).
- **Bundled skill**: `using-ctx-tree` (with Serena complement note).
- **Bun workspace**: root `package.json` with workspace config — all commands run from repo root.
- **Prebuilt native deps** for macOS arm64 + Linux x64/arm64, distributed via GitHub release artifacts + postinstall download (not committed to the repo).

### v1 is "done" when

1. Plugin installs via marketplace (postinstall pulls the correct native binary archive from the GitHub release on first run); MCP server boots in <500ms cold after that.
2. `ctx-tree.search(query, mode='keyword')` returns FTS-ranked results across a populated store, defaulting to `WHERE status = 'live'`. Calls with `mode='hybrid'` or `mode='semantic'` are rejected with the documented error.
3. `ctx-tree.compose(seeds, budget, format='raw' | 'outline')` produces a context bundle within the requested token budget; the manifest correctly reports included/dropped nodes and any truncated content. `format='mixed'` returns an explicit "deferred to v1.1" error in v1.
4. The three v1 walkers run on schedule; `pending → live → stale → pruned` transitions are observable in the DB. Coordinator runs a startup sweep of pre-existing `pending` rows on boot.
5. CtxTree-backed tool round-trip <50ms median for **cached chunks**, where "cached" in v1 means the node already exists in SQLite with unchanged `mtime`.
6. `ctx-tree.read` rejects secret-file paths (`.env`, `~/.ssh/id_rsa`, `~/.aws/credentials`, etc.) via the path denylist before any DB write — verified by eval security cases.
7. The eval harness (below) passes on a fresh checkout.
8. Bundled `using-ctx-tree` skill activates and is discoverable by the agent.

### Eval harness

`mcp/eval/` ships with:

- A **fixture repo** (~30 files, mixed sizes, with a known symbol/structure layout).
- **Golden queries**: ~20 search assertions (term → expected top-N node IDs) and ~10 compose assertions (`compose(seed_set, budget)` → expected manifest hash).
- **Latency assertions**: cold start <500ms (post-binary-cache); ctx-tree-backed tool median <50ms (cached chunks per def. above); hook overhead p95 <40ms end-to-end; server-side ingestion p95 <20ms; cheap-filter fast-path p95 `pending → live` <100ms.
- **Concurrent-project routing**: scripted spawn of two MCP servers in different cwds; verify that captures from each session land only in the matching project's DB (no cross-contamination).
- **Hook payload normalization**: golden fixtures for Bash, Read, Grep, Glob, Write, and Edit `PostToolUse` payloads — each must produce a well-formed node row with the expected `tool`, `response`, and `ts` (epoch ms) fields.
- **Tool-schema rejection**: `ctx-tree.search(mode='hybrid')` and `ctx-tree.compose(format='mixed')` both return the documented v1.1-deferred error rather than silently degrading.
- **Budget assertions**: `compose` never overruns budget; `truncated` flag set correctly on capped nodes.
- **Security assertions**: a list of known-leaky Bash outputs (env dumps, AWS creds, GitHub tokens, JWTs) must all redact to clean state *before* `INSERT`, **plus** a list of secret-file path attempts (`.env`, `~/.ssh/id_rsa`, `~/.aws/credentials`, etc.) via Read/Grep must drop the whole node before `INSERT` — verified by inspecting DB rows post-run.
- **Negative retrieval**: stale, superseded, and pruned nodes are absent from default-filtered `search`, `compose`, and `neighbors` results; passing an explicit `status` filter returns them.
- **Truncation manifest**: any node where `original_bytes > capture.maxBytes` has `truncated=1`, and `compose` surfaces a warning in the manifest naming the truncated node IDs.
- **Graceful degradation**: with the MCP server killed (no socket), native Read/Grep/Bash calls still complete normally; the hook exits silently within 1s and emits no stderr visible to Claude.

Run via `bun mcp/eval/run.ts`; CI gates on it.

### Deferred to v1.1 (explicit non-goals for v1)

- `embedding_indexer`, `summarizer`, `dedupe` walkers.
- Semantic and hybrid search (`mode='semantic'`, `mode='hybrid'`).
- Ollama and Anthropic-API soft dependencies (no embedding/summarization code paths in v1).
- The `nodes_vec` table is created but stays empty in v1.
- `ctx-tree.bash` execution tool — see §1 roadmap and §10 risks.
- Bundled compiled hook binary (replaces `jq`/`socat` system deps).

---

## 12. Out of Scope (v1)

- Live subscriptions (`watch(query)`).
- Multi-machine sync.
- Web/VS Code UI.
- Replacing every native tool — ctx-tree augments.
- User-facing query language beyond the MCP tools listed.
