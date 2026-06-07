---
name: ctx-tree workflow
description: Use when navigating an unfamiliar codebase, tracing call chains, finding related code, building context for a complex change, or recalling prior session work. Also use when the task involves reading multiple related files, searching across a codebase, or fetching web content that should be stored for later recall.
---

# ctx-tree Workflow

ctx-tree builds a navigation graph as you work. Every `ctx_tree_read` and `ctx_tree_grep` call stores nodes in a persistent SQLite graph keyed by project. The graph survives across sessions — prior reads are available via `ctx_tree_search` and `ctx_tree_recent` without re-reading files.

## Core Pattern: Read → Neighbors → Compose

```
1. ctx_tree_read(path)          → content + nodeIds
2. ctx_tree_neighbors(nodeId)   → related nodes (callers, imports, siblings)
3. ctx_tree_compose(nodeIds, budget_tokens)  → focused context slice
```

Use this chain instead of reading multiple files sequentially. `compose` assembles content from stored nodes within a token budget — you get exactly what fits without re-reading anything.

## Tool Reference

| Tool | When to use |
|------|-------------|
| `ctx_tree_read` | Read any code or config file. Always prefer over `Read`. |
| `ctx_tree_grep` | Search by regex across files. Always prefer over `Grep` or `Bash(rg)`. |
| `ctx_tree_search` | Keyword search across all stored nodes this session and prior sessions. |
| `ctx_tree_neighbors` | After a read or grep, find related nodes — callers, importers, siblings. |
| `ctx_tree_compose` | Assemble a context bundle from node IDs within a token budget. |
| `ctx_tree_recent` | Surface what was captured in prior sessions at session start. |
| `ctx_tree_path_to_root` | Walk the parent chain from any node to understand file structure. |
| `ctx_tree_browse` | Fetch a URL, strip to readable text, store as web_chunk node. Prefer over WebFetch. |
| `ctx_tree_monitor` | Run a shell command, capture all output to a stored node, return nodeId + preview. Use instead of Bash/Monitor when output could be large. |

## Session Start

Run these before diving into a task when resuming prior work:

```
ctx_tree_recent()          → what was captured before
ctx_tree_search("topic")   → relevant stored nodes
ctx_tree_compose(nodeIds)  → build a context bundle from hits
```

## Exploring an Unfamiliar File

```
ctx_tree_read(path)                    → read + get nodeIds
ctx_tree_neighbors(nodeIds[0])         → find callers, imports
ctx_tree_grep(pattern, path=dir)       → search related symbols
ctx_tree_compose([...nodeIds], 4000)   → assemble focused slice
```

## Tracing a Call Chain

```
ctx_tree_grep("functionName")          → find all call sites → nodeIds
ctx_tree_neighbors(callSiteNodeId)     → find the calling function's file root
ctx_tree_read(callerFilePath)          → read the caller
ctx_tree_compose([...nodeIds], 3000)   → assemble the chain
```

## Web Content

```
ctx_tree_browse(url)                   → compact reference + nodeId
ctx_tree_neighbors(nodeId)             → find related stored pages
ctx_tree_search("topic from that page") → recall without re-fetching
```

## Budget Control

Pass `budget_tokens` to `ctx_tree_read` and `ctx_tree_compose` to control context size:

```
ctx_tree_read(path, budget_tokens=1000)           → first ~1000 tokens of file
ctx_tree_compose([id1, id2], budget_tokens=3000)  → up to 3000 tokens from those nodes
```

## Red Flags

- Calling native `Read` → the PreToolUse hook will block and redirect. Use `ctx_tree_read`.
- Calling `Bash(rg ...)` or `Grep` → blocked. Use `ctx_tree_grep`.
- Calling `WebFetch` → blocked. Use `ctx_tree_browse`.
- "I already read this file" → check `ctx_tree_search` first; the node may be cached from this session or a prior one.
- "I need to understand the whole file" → use `ctx_tree_read` with no budget; tree-sitter will chunk it and return all symbols.
