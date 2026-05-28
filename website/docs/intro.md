---
id: intro
title: Introduction
sidebar_position: 1
---

# memtree

**Claude Code with a photographic memory.**

memtree is a persistent SQLite property graph that sits between Claude Code and every tool call. When Claude reads a file, runs a grep, fetches a URL, or calls any MCP tool, a hook intercepts the result, stores it in the graph, and returns a compact `nodeId` reference (~60 tokens) instead of dumping raw data into the context window.

The same operation next week costs zero tokens. It's already in the graph.

---

## The problem

LLM context windows are a scarce, write-once resource. Tool calls flood the window with low-signal data:

- `Read` on a 500-line file: ~4,200 tokens, used once, never freed
- `Grep` across 8 files: ~8,400 tokens, immediately stale
- `WebFetch` on API docs: ~11,000 tokens, 90% noise

By the time a complex task is 60% done, the window is full of content that already answered its question. Claude starts dropping earlier context. Sessions die before work is done.

This is **context rot**.

---

## The solution

memtree intercepts every tool call via Claude Code hooks:

1. The native tool is **blocked** — no raw data enters the context window
2. The equivalent **memtree MCP tool** runs instead
3. The result is **stored in the graph** — chunked, indexed, linked
4. Claude gets back a **compact nodeId** (~60 tokens)
5. Any future session can **recall it for free** via `memtree_compose`

The graph persists across sessions. Knowledge accumulates. Context stays lean.

---

## Next steps

- [Install memtree](./installation) — one-line install via agent marketplace
- [Getting Started](./getting-started) — first session walkthrough
- [How it works](./user-guide/how-it-works) — deep dive into the architecture
