---
id: changelog
title: Changelog
sidebar_position: 10
---

# Changelog

## v0.1.0

Initial release.

### MCP Tools

- `ctx_tree_read` — file reading with tree-sitter semantic chunking and mtime caching
- `ctx_tree_grep` — ripgrep integration with result nodes stored in graph
- `ctx_tree_browse` — URL fetching with accessibility tree extraction and caching
- `ctx_tree_compose` — BFS graph expansion + relevance scoring + budget-bounded context assembly
- `ctx_tree_search` — FTS5 keyword search across all stored nodes
- `ctx_tree_neighbors` — graph walk from a node up to depth 5
- `ctx_tree_path_to_root` — spine walk from any node to session root
- `ctx_tree_recent` — surface nodes from prior sessions by recency
- `ctx_tree_monitor` — shell command execution with output stored as node
- `ctx_tree_note` — manual note/observation storage

### Hooks (10 total)

- `session-start.mjs` — tool guide injection on SessionStart
- `pretooluse-redirect.mjs` — Read/Grep/WebFetch/Bash(grep|cat) interception
- `pretooluse-agent-enrich.mjs` — Agent prompt enrichment with FTS context hits
- `pretooluse-skill-recall.mjs` — Skill cache hit/miss routing
- `pretooluse-proxy.mjs` — soft advisory mode (opt-in)
- `posttooluse-agent-capture.mjs` — Agent summary node creation
- `posttooluse-skill-capture.mjs` — Skill content caching
- `posttooluse-websearch-capture.mjs` — WebSearch result URL browsing
- `userpromptsubmit-capture.mjs` — prompt node capture with follows edges
- `stop-response-capture.mjs` — thinking + response node capture with full edge chain

### Infrastructure

- SQLite property graph store at `~/.ctx-tree/<project-hash>/store.db`
- Git-based project hash (`sha256(gitRoot:firstCommit).slice(0, 16)`)
- Background walkers: staleness marker, pruner
- `mcp-exec` integration for sandboxed execution
- Plugin manifest with `/usr/bin/env bun` for cross-platform hook commands
- Sensitive value redaction in `ctx_tree_monitor` output before storage

---

## Roadmap

### v0.1.1 (planned)

- Passive capture via PostToolUse hook (store native Read/Grep/Bash output automatically)
- Embedding indexer walker (Ollama / OpenAI)
- Summarization walker (Haiku 4.5)
- Deduplication walker (cosine ≥ 0.97 merge)
- Hybrid search (RRF over FTS + semantic)

### v0.2.0 (planned)

- `ctx_tree_bash` — Bash equivalent routed through mcp-exec for sandboxing
- Bundled hook binary (eliminates `jq`/`socat` system deps)
- EdgeLight backend option (embedded property graph DB)

### Future

- VS Code inspector companion extension
- Multi-project store federation
