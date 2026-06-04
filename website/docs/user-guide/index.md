---
id: index
title: User Guide
sidebar_position: 1
---

# User Guide

This guide covers how to use ctx-tree effectively in your day-to-day Claude Code sessions.

## Contents

- **[How it works](/docs/user-guide/how-it-works)** — Architecture overview, node types, edge types, and the processing pipeline
- **[MCP Tools](/docs/user-guide/mcp-tools)** — Practical usage patterns for all 10 MCP tools
- **[Hooks](/docs/user-guide/hooks)** — What each hook intercepts and when it fires

## Core concepts

### The graph

ctx-tree stores everything in a SQLite property graph at `~/.ctx-tree/<project-hash>/store.db`. Each tool call result becomes a **node** with a unique ULID identifier. Nodes are connected by **edges** that capture semantic relationships (file chunks to their parent file, a response derived from a prompt, an agent summary that summarizes its subagent's work).

### The token contract

Every ctx-tree tool returns a compact reference — a `nodeId` plus a few metadata fields. The actual content stays in the graph. When you need to work with the content, use `ctx_tree_compose` to retrieve it within a token budget. This two-step pattern (store → reference → compose) is the core of how ctx-tree keeps context lean.

### Sessions

ctx-tree creates a `session` node on SessionStart and links all nodes created during that session under it. Sessions persist in the graph, so you can always trace back to what was read during a specific session. `ctx_tree_recent` uses this to orient you when re-entering a project.

## Quick reference

```
Read a file          → ctx_tree_read({ path })
Search file content  → ctx_tree_grep({ pattern, path })
Fetch a URL          → ctx_tree_browse({ url })
Search stored nodes  → ctx_tree_search({ query })
Retrieve content     → ctx_tree_compose({ node_ids, budget_tokens })
Walk the graph       → ctx_tree_neighbors({ node_id, depth })
Surface prior work   → ctx_tree_recent({ limit })
Store a note         → ctx_tree_note({ content })
Run a command        → ctx_tree_monitor({ command })
```
