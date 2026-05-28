---
id: index
title: User Guide
sidebar_position: 1
---

# User Guide

This guide covers how to use memtree effectively in your day-to-day Claude Code sessions.

## Contents

- **[How it works](/docs/user-guide/how-it-works)** — Architecture overview, node types, edge types, and the processing pipeline
- **[MCP Tools](/docs/user-guide/mcp-tools)** — Practical usage patterns for all 10 MCP tools
- **[Hooks](/docs/user-guide/hooks)** — What each hook intercepts and when it fires

## Core concepts

### The graph

memtree stores everything in a SQLite property graph at `~/.memtree/<project-hash>/store.db`. Each tool call result becomes a **node** with a unique ULID identifier. Nodes are connected by **edges** that capture semantic relationships (file chunks to their parent file, a response derived from a prompt, an agent summary that summarizes its subagent's work).

### The token contract

Every memtree tool returns a compact reference — a `nodeId` plus a few metadata fields. The actual content stays in the graph. When you need to work with the content, use `memtree_compose` to retrieve it within a token budget. This two-step pattern (store → reference → compose) is the core of how memtree keeps context lean.

### Sessions

memtree creates a `session` node on SessionStart and links all nodes created during that session under it. Sessions persist in the graph, so you can always trace back to what was read during a specific session. `memtree_recent` uses this to orient you when re-entering a project.

## Quick reference

```
Read a file          → memtree_read({ path })
Search file content  → memtree_grep({ pattern, path })
Fetch a URL          → memtree_browse({ url })
Search stored nodes  → memtree_search({ query })
Retrieve content     → memtree_compose({ node_ids, budget_tokens })
Walk the graph       → memtree_neighbors({ node_id, depth })
Surface prior work   → memtree_recent({ limit })
Store a note         → memtree_note({ content })
Run a command        → memtree_monitor({ command })
```
