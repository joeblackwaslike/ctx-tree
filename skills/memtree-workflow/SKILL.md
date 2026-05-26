---
name: memtree workflow
description: Use when navigating an unfamiliar codebase, tracing call chains, finding related code, building context for a complex change, or recalling prior session work. Also use when the task involves reading multiple related files, searching across a codebase, or fetching web content that should be stored for later recall.
---

# memtree Workflow

memtree builds a navigation graph as you work. Every `memtree_read` and `memtree_grep` call stores nodes in a persistent SQLite graph keyed by project. The graph survives across sessions — prior reads are available via `memtree_search` and `memtree_recent` without re-reading files.

## Core Pattern: Read → Neighbors → Compose

```
1. memtree_read(path)          → content + nodeIds
2. memtree_neighbors(nodeId)   → related nodes (callers, imports, siblings)
3. memtree_compose(nodeIds, budget_tokens)  → focused context slice
```

Use this chain instead of reading multiple files sequentially. `compose` assembles content from stored nodes within a token budget — you get exactly what fits without re-reading anything.

## Tool Reference

| Tool | When to use |
|------|-------------|
| `memtree_read` | Read any code or config file. Always prefer over `Read`. |
| `memtree_grep` | Search by regex across files. Always prefer over `Grep` or `Bash(rg)`. |
| `memtree_search` | Keyword search across all stored nodes this session and prior sessions. |
| `memtree_neighbors` | After a read or grep, find related nodes — callers, importers, siblings. |
| `memtree_compose` | Assemble a context bundle from node IDs within a token budget. |
| `memtree_recent` | Surface what was captured in prior sessions at session start. |
| `memtree_path_to_root` | Walk the parent chain from any node to understand file structure. |
| `memtree_browse` | Fetch a URL, strip to readable text, store as web_chunk node. Prefer over WebFetch. |

## Session Start

Run these before diving into a task when resuming prior work:

```
memtree_recent()          → what was captured before
memtree_search("topic")   → relevant stored nodes
memtree_compose(nodeIds)  → build a context bundle from hits
```

## Exploring an Unfamiliar File

```
memtree_read(path)                    → read + get nodeIds
memtree_neighbors(nodeIds[0])         → find callers, imports
memtree_grep(pattern, path=dir)       → search related symbols
memtree_compose([...nodeIds], 4000)   → assemble focused slice
```

## Tracing a Call Chain

```
memtree_grep("functionName")          → find all call sites → nodeIds
memtree_neighbors(callSiteNodeId)     → find the calling function's file root
memtree_read(callerFilePath)          → read the caller
memtree_compose([...nodeIds], 3000)   → assemble the chain
```

## Web Content

```
memtree_browse(url)                   → compact reference + nodeId
memtree_neighbors(nodeId)             → find related stored pages
memtree_search("topic from that page") → recall without re-fetching
```

## Budget Control

Pass `budget_tokens` to `memtree_read` and `memtree_compose` to control context size:

```
memtree_read(path, budget_tokens=1000)           → first ~1000 tokens of file
memtree_compose([id1, id2], budget_tokens=3000)  → up to 3000 tokens from those nodes
```

## Red Flags

- Calling native `Read` → the PreToolUse hook will block and redirect. Use `memtree_read`.
- Calling `Bash(rg ...)` or `Grep` → blocked. Use `memtree_grep`.
- Calling `WebFetch` → blocked. Use `memtree_browse`.
- "I already read this file" → check `memtree_search` first; the node may be cached from this session or a prior one.
- "I need to understand the whole file" → use `memtree_read` with no budget; tree-sitter will chunk it and return all symbols.
