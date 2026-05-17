# memtree — Design Spec

**Date:** 2026-05-17
**Status:** Draft (awaiting user approval before implementation plan)
**Author:** Joe Black
**Repository:** github.com/joeblackwaslike/memtree

---

## 1. Problem & Goals

LLM context windows are a scarce, expensive, write-once resource. Tool outputs (Read, Grep, Bash) flood the window with low-signal data that compounds across turns; the model must then carry that ballast through every subsequent inference. Compaction helps but is lossy and not deterministic.

**memtree** is an external, persistent, tree- and graph-shaped context store with surgical recall. There are two paths into it:

1. **Wrapped tools** (`memtree.read`, `memtree.grep`, `memtree.bash`) — the full output goes to the store; only a budget-bounded slice returns to the window. This is how raw outputs are kept *out* of context.
2. **Passive capture** via a `PostToolUse` hook on the native Read/Grep/Bash — the model has already seen those outputs, so the hook can only index them for *future* recall (it cannot rewrite a tool result Claude already received).

Retrieval happens through MCP tools (`search`, `compose`, `neighbors`) and pulls only the bytes needed.

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

Rationale: path-dependent by design — moving or re-cloning the repo to a different absolute path yields a new hash and a fresh store. Including the first-commit SHA reduces collision risk between unrelated repos that happen to share a path. If clone-stable IDs are needed later, swap `git_root_path` for the canonical remote URL; this is deferred because it's brittle for repos without a remote.

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
| `truncated`    | INTEGER  | 1 if content was truncated at `capture.maxBytes`; 0 otherwise  |
| `original_bytes`| INTEGER | Pre-truncation byte count (for callers deciding whether to re-fetch) |
| `metadata`     | TEXT     | JSON blob (token counts, tool name, line ranges, etc.)         |

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

## 4. mcp-exec Wrapper Contract

The wrappers are memtree's **only** mechanism for keeping raw outputs out of the window. `PostToolUse` hooks cannot mutate a tool result Claude has already received — verified against the Claude Code hooks API as of 2026-05: the hook output schema is `continue` / `suppressOutput` / `systemMessage` (and Exit 2 stderr-as-error for command hooks). There is no `updatedToolOutput` analogue to PreToolUse's `updatedInput`. The hook can only *add* context as a separate system message; it cannot replace the tool result the model already saw.

So the contract is: each wrapper writes the full output to the store and returns either a node ID + bounded preview, or the raw content within a caller-specified token budget. The agent reaches for these instead of the native Read/Grep/Bash whenever it expects the output to be large.

### Wrapped tools (MCP server exposes)

- `memtree.read(path, lines?, budget_tokens?)` — wraps Read; chunks file into nodes by symbol or by 200-line windows; returns the requested slice; reuses existing node if `mtime` unchanged.
- `memtree.grep(pattern, path?, ...)` — wraps Grep; stores result set as a `tool_output` node + per-hit child `file_chunk` nodes for the lines hit.
- `memtree.bash(command, ...)` — wraps Bash; stores stdout/stderr as `tool_output`; returns truncated preview + node ID.

### Cache invalidation

- For `file_chunk` nodes: compare `mtime` on retrieval; if source file changed, mark old node `stale`, create new node, write `supersedes` edge **newer → older** (the new node points back at what it replaces). This matches §3's definition of `superseded`: "pointed at by a `supersedes` edge from a newer node."
- For `tool_output` nodes: keep all (audit trail); dedupe by `content_hash` against existing nodes in the same hour window.

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

The `PostToolUse` hook is **passive indexing only** — it cannot rewrite the tool result Claude already saw (see §4). Its job is to make native tool outputs available for *future* `memtree.search` / `memtree.compose` calls. Captured data lands in `status=pending`; the `filter` walker triages.

Hook-level capture is allowlisted at the matcher (`Read|Grep|Bash`) but otherwise greedy: filtering happens in-walker, where size, dedupe state, and recent neighbors are all available. Default `filterMinSize=50` bytes and `maxBytes=100000` per node bound the worst case.

### Ingestion path: hook → MCP server over Unix socket

The hook does **not** open SQLite directly. A ~80–150ms Node cold start plus `better-sqlite3` load plus WAL handshake on every `Read`/`Grep`/`Bash` would be a tax the agent feels in every turn. Instead:

1. The MCP server, already running for the session, listens on a Unix socket at `~/.memtree/<project-hash>/ingest.sock` (mode `0600`).
2. The hook is a tiny script that JSON-encodes `{ tool, input, output, exit, cwd, ts }` and writes one line to the socket. No DB handle, no walker contention.
3. The server's ingestion handler does the redacted `INSERT … status='pending'` via a prepared statement (~1ms) and acks. Any failure — socket missing, server crashed, EAGAIN — is logged to stderr and silently dropped. memtree must never block tool calls.

Realistic hook overhead: **~5–15ms** end-to-end including the socket round-trip. This stays under the noise floor of most tool calls. The earlier ≤5ms claim was wrong — it omitted Node startup. The socket design dodges startup entirely because the hook itself can be a short shell script (`jq -c | socat - UNIX-CONNECT:…`) rather than a Node process.

### Security: capture-time redaction

`Capture-all` is fine for Read/Grep but dangerous for Bash, which can pipe `env`, `printenv`, `aws sts get-caller-identity`, `gh auth token`, etc. Filtering after the fact is too late — the secret already landed in the row, the FTS index, and (eventually) the embedding.

So the ingestion handler applies redaction **before** `INSERT`:

- **Command denylist** (drop the whole node): `env`, `printenv`, any binary listed in a per-project denylist file at `~/.memtree/<project-hash>/bash.deny` (one regex per line).
- **Output-string redaction** (replace in-place with `[REDACTED:<tag>]`): regex set for AWS access keys (`AKIA…`, `ASIA…`), GitHub tokens (`ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_…`), JWT bearer tokens, `AWS_SECRET_…=`, `OPENAI_API_KEY=`, `ANTHROPIC_API_KEY=`, and generic 32+ char hex/base64 blobs following a `secret`/`token`/`password`/`key=` lexical context.
- **Per-project opt-out**: a project can set `capture.bash = false` in its sidecar config to disable Bash capture entirely.
- **Filesystem hardening**: `~/.memtree/<project-hash>/` created at `0700`, `store.db` at `0600`.

The redaction rules ship as a versioned module so users can audit and extend them. v1 ships with the rules above plus a test fixture of known-leaky outputs that must all redact to clean state — see §11.

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

### Native dependencies

Both `better-sqlite3` and `sqlite-vec` ship native binaries. The marketplace install flow does **not** run `npm install`, so the plugin must arrive with everything resolved.

v1 ships prebuilt binaries for the three platforms users actually have:

- macOS `arm64` (M-series)
- Linux `x64`
- Linux `arm64`

Strategy: a `mcp/scripts/prepare-release.sh` script runs during release (driven by `gh release create`) and, for each target triple, fetches the prebuilt binary via `prebuild-install` for `better-sqlite3` and the matching `sqlite-vec` release artifact, then commits them into `mcp/prebuilds/<platform>-<arch>/`. The server picks the right one at startup via `process.platform` + `process.arch`.

A `postinstall` fallback is documented (for users who clone the plugin manually rather than installing via marketplace), but the happy path is "install via marketplace, run, done."

Other platforms (Windows, Linux `x86`, BSDs) are out of v1 scope. The server logs a clear `unsupported platform: <triple>` error and exits.

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

- **Hook latency.** `PostToolUse` runs synchronously. The socket-ingestion design in §7 targets ~5–15ms p50, but a slow socket write (server pinned by walker, OS scheduler hiccup) could leak into tool calls. Mitigation: hook is fire-and-forget — any failure is logged and dropped, never retried in-line. Eval harness has a p95 <20ms gate.
- **Filter walker tuning.** `Capture-all + filter` means the filter walker is the gatekeeper of store cleanliness. Bad heuristics → store bloat. Plan: ship conservative defaults (size threshold + exact dedupe only), expose `filterMinSize` and a custom filter hook for users to extend.
- **Redaction false negatives.** Hook-time redaction (§7) is regex-based — a novel secret format will leak. Mitigation: ship a known-leaky-output test fixture in the eval harness; bias toward dropping the whole node when *any* denylist regex matches the command itself.
- **`summarizer` cost (v1.1+).** Haiku 4.5 isn't free; large sessions could accumulate calls. Deferred from v1; when added, only fires when subtree exceeds threshold; rate-limited; respects daily cap in config.
- **Embedding model drift (v1.1+).** Changing `embeddingModel` mid-project makes existing vectors unusable. Mitigation lives in the schema: `nodes_vec.embedding_model` + `embedding_dim` per row (§3); mixed-model search is rejected at query time; users get a one-shot re-embed command.
- **Project-hash collisions.** sha256 truncated to 16 hex chars (~64 bits) — collision-resistant for any realistic project count. Path-dependent by design (see §2).

---

## 11. Acceptance Criteria

v1 narrows the surface vs. earlier drafts. The embedding indexer, summarizer, and dedupe walkers — and therefore semantic and hybrid search — are deferred to v1.1. They're the riskiest pieces (model drift, API cost, false-merge risk on near-duplicates), and FTS-only retrieval is more than enough to validate the rest of the architecture.

### v1 ships

- **Wrappers**: `memtree.read`, `memtree.grep`, `memtree.bash`, `memtree.compose`.
- **Query API**: `memtree.search` (keyword/FTS only — `mode='hybrid'` and `mode='semantic'` deferred), `memtree.neighbors`, `memtree.path_to_root`, `memtree.recent`.
- **Walkers**: `filter`, `staleness_marker`, `pruner`.
- **Capture**: `PostToolUse` hook → MCP-server-over-socket with redaction (§7).
- **Bundled skill**: `using-memtree`.
- **Prebuilt native deps** for macOS arm64 + Linux x64/arm64.

### v1 is "done" when

1. Plugin installs via marketplace; MCP server boots in <500ms cold; `PostToolUse` hook captures Read/Grep/Bash outputs with no measurable latency increase in tool calls (p95 ingestion <20ms).
2. `memtree.search` returns FTS-ranked results across a populated store, defaulting to `WHERE status = 'live'`.
3. `memtree.compose(seeds, budget, format='mixed')` produces a context bundle within the requested token budget; the manifest correctly reports included/dropped nodes.
4. The three v1 walkers run on schedule; `pending → live → stale → pruned` transitions are observable in the DB.
5. Tool wrapper round-trip <50ms median for cached chunks.
6. The eval harness (below) passes on a fresh checkout.
7. Bundled `using-memtree` skill activates and is discoverable by the agent.

### Eval harness

`mcp/eval/` ships with:

- A **fixture repo** (~30 files, mixed sizes, with a known symbol/structure layout).
- **Golden queries**: ~20 search assertions (term → expected top-N node IDs) and ~10 compose assertions (`compose(seed_set, budget)` → expected manifest hash).
- **Latency assertions**: cold start <500ms; wrapper median <50ms; hook ingestion p95 <20ms.
- **Budget assertions**: `compose` never overruns budget; `truncated` flag set correctly on capped nodes.
- **Security assertions**: a list of known-leaky Bash outputs (env dumps, AWS creds, GitHub tokens, JWTs) must all redact to clean state *before* `INSERT` — verified by inspecting DB rows post-run.

Run via `bun mcp/eval/run.ts`; CI gates on it.

### Deferred to v1.1 (explicit non-goals for v1)

- `embedding_indexer`, `summarizer`, `dedupe` walkers.
- Semantic and hybrid search (`mode='semantic'`, `mode='hybrid'`).
- Ollama and Anthropic-API soft dependencies (no embedding/summarization code paths in v1).
- The `nodes_vec` table is created but stays empty in v1.

---

## 12. Out of Scope (v1)

- Live subscriptions (`watch(query)`).
- Multi-machine sync.
- Web/VS Code UI.
- Replacing every native tool — memtree augments.
- User-facing query language beyond the MCP tools listed.
