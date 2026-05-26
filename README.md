# 🌳 memtree

**Persistent SQLite property graph for Claude Code.**
Every tool call builds the graph. Claude gets compact references, not raw data.

[📊 Full Visualization](docs/how-it-works.html) · [⚡ Quick Overview](docs/mini.html) · [📄 Design Spec](docs/superpowers/specs/2026-05-17-memtree-design.md)

---

## The Problem

Claude Code sessions die from context rot. Every tool call dumps raw file contents, grep output, and web pages straight into the context window. A session that reads 8 files, runs a few web fetches, and calls some MCP tools burns 60–80k tokens on raw data — leaving almost nothing for reasoning. The session stalls before the work is done.

## The Solution

memtree intercepts every tool call via Claude Code hooks — native **and** MCP. Content lands in a persistent SQLite property graph, chunked by symbol and indexed. Claude gets back a compact `nodeId` reference, not raw bytes. The same file read again — next turn or next week — costs zero tokens. It's already in the graph.

## Context Savings

| Operation | Without memtree | With memtree | Saved |
| --------- | --------------- | ------------ | ----- |
| Read file | ~4,200 tok | ~60 tok | **98.6%** |
| Grep (8 files) | ~8,400 tok | ~160 tok | **98.1%** |
| WebFetch | ~11,000 tok | ~110 tok | **99.0%** |
| MCP tool | ~3,600 tok | ~70 tok | **98.1%** |

Knowledge accumulates across sessions — a file read last week is available today via `memtree_compose` without re-reading it. You can do in one session what used to take five.

## Install

```sh
# 1. Add the agent marketplace (one-time)
/plugin marketplace add joeblackwaslike/agent-marketplace

# 2. Install memtree — MCP server, hooks, and skills configured automatically
/plugin install memtree@agent-marketplace
```

**Requirements:** macOS arm64 or Linux x64/arm64 · [Bun ≥1.1](https://bun.sh) · `rg ≥13`

```sh
# macOS
brew install bun ripgrep

# Linux
curl -fsSL https://bun.sh/install | bash && apt install ripgrep
```

## How It Works

```text
Hook fires → Native blocked → memtree_* runs → Node stored → nodeId returned → compose() on demand
(PreToolUse)   (deny emitted)   (MCP tool)      (SQLite graph)  (~60 tokens)     (surgical recall)
```

memtree intercepts `Read`, `Grep`, `Bash` (grep/cat), `WebFetch`, `Monitor`, `Agent`, `Skill`, and all MCP tool calls. Hooks are installed automatically — no per-project setup needed.

## MCP Tools

| Tool | Description |
| ---- | ----------- |
| `memtree_read` | Read file with tree-sitter semantic chunking. Returns nodeId + symbol index. |
| `memtree_grep` | Ripgrep search with results stored as graph nodes. |
| `memtree_browse` | Fetch a URL, store as web_content node with accessibility tree. |
| `memtree_search` | FTS5 keyword search across all stored nodes — current and prior sessions. |
| `memtree_compose` | Budget-bounded context bundle from seed nodeIds. No re-reads. |
| `memtree_neighbors` | Graph walk from a node — callers, imports, siblings, summaries. |
| `memtree_path_to_root` | Walk parent chain from any node to the session root. |
| `memtree_recent` | Surface nodes captured in prior sessions. Instant orientation. |
| `memtree_monitor` | Stream command output as chunk nodes. Supports stdin sends. |
| `memtree_note` | Manually store an observation or note node with optional edges. |

## Hooks

All hooks are installed automatically by the plugin.

| Event | File | What it does |
| ----- | ---- | ------------ |
| `SessionStart` | `session-start.mjs` | Injects memtree tool guide and redirect reminders on startup/resume. |
| `UserPromptSubmit` | `userpromptsubmit-capture.mjs` | Stores prompts ≥100 chars as `observation` nodes. Surfaces in future sessions. |
| `PreToolUse` | `pretooluse-redirect.mjs` | Hard-denies Read/Grep/Bash(grep,cat)/WebFetch/Monitor. Injects exact `memtree_*` replacement. |
| `PreToolUse` | `pretooluse-agent-enrich.mjs` | Enriches Agent prompt with memtree tool map + FTS context hits from prior work. |
| `PreToolUse` | `pretooluse-skill-recall.mjs` | Cache hit: denies Skill, injects `memtree_compose` ref. Cache miss: passthrough + store. |
| `PreToolUse` | `pretooluse-proxy.mjs` | Soft advisory mode (when `~/.memtree/proxy-mode` flag set) — nudges without blocking. |
| `PostToolUse` | `posttooluse-agent-capture.mjs` | Creates summary node linking all subagent work. Emits `summarizes` edges. |
| `PostToolUse` | `posttooluse-skill-capture.mjs` | Stores skill content as cached node keyed by `skill://name`. |
| `PostToolUse` | `posttooluse-websearch-capture.mjs` | Fire-and-forget browse of each search result URL — pages available in future searches. |

## Built On

memtree is built on **[mcp-exec](https://github.com/joeblackwaslike/mcp-exec)** — a context-efficient MCP workflow execution engine that runs multi-step MCP tool chains in a sandboxed environment, returning only the final output to the model's context window.

## Development Setup

After cloning, activate the tracked git hooks:

```sh
git config core.hooksPath .githooks
```

This auto-rebuilds `mcp/dist/server.js` whenever you commit changes to `mcp/src/`.

---

## Coming Soon

> **EdgeLight backend** — memtree's SQLite store will gain an optional backend powered by EdgeLight: a custom-built single-file embedded graph database (no server, no daemon, no EdgeDB installation required). EdgeLight brings a proper property graph query language, richer edge semantics, and faster graph traversal — while keeping the zero-install, per-project isolation that makes memtree deployable anywhere. Just have to build it first.

---

[📊 Full Visualization](docs/how-it-works.html) · [⚡ Quick Overview](docs/mini.html) · [GitHub](https://github.com/joeblackwaslike/memtree) · [Agent Marketplace](https://github.com/joeblackwaslike/agent-marketplace) · [mcp-exec](https://github.com/joeblackwaslike/mcp-exec)
