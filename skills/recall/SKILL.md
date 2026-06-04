---
name: recall
description: Use when starting work in a familiar codebase, recalling prior context or decisions, reading code files, searching for symbols or patterns, or building token-budget context for a complex task. Also activates on session start to surface prior session captures.
---

# ctx-tree recall

Core principle: The store knows what's true now. Training memory knows what was true at cutoff. Always search the store before guessing.

## Session Start Protocol

Run this immediately when the session-start hook fires or when resuming work in a known project:

```
ctx_tree_recent()                    → surface nodes from prior sessions
ctx_tree_search("current task topic") → pull relevant stored context
ctx_tree_compose(nodeIds, 4000)      → build a context bundle from hits
```

Skip cold reads — if the store has it, compose from it instead.

## Tool Map (always-on)

Hooks enforce these redirects automatically. When a hook blocks a native tool, it injects the exact replacement call. Use it.

| Instead of | Use |
|------------|-----|
| `Read(file_path: "X")` | `ctx_tree_read({ path: "X" })` |
| `Grep(pattern: "X", path: "Y")` | `ctx_tree_grep({ pattern: "X", path: "Y" })` |
| `Bash("rg X")` / `Bash("cat X")` | `ctx_tree_grep(...)` / `ctx_tree_read(...)` |
| `WebFetch(url: "X")` | `ctx_tree_browse({ url: "X" })` |
| `Monitor(command: "X")` | `ctx_tree_monitor({ command: "X" })` |
| `PowerShell(script: "X")` | `ctx_tree_grep(...)` / `ctx_tree_read(...)` / `ctx_tree_browse(...)` |
| `Edit` / `Write` / `MultiEdit` | Native — write ops don't bloat context |

## During Work

- After any `ctx_tree_read`, call `ctx_tree_neighbors(nodeId)` to find related code.
- After `ctx_tree_grep`, inspect the returned nodeIds — they're already in the graph.
- Use `ctx_tree_compose` to assemble multi-file context within a token budget.
- Use `ctx_tree_search` before re-reading a file that was already read this session or in a prior one.

## Tool Reference

| Tool | Use when |
|------|----------|
| `ctx_tree_recent` | Session start — surface prior session captures |
| `ctx_tree_search` | Keyword lookup across all stored nodes |
| `ctx_tree_compose` | Token-budget context bundle from seed nodes |
| `ctx_tree_read` | Read a file — tree-sitter chunks, mtime cache, stored |
| `ctx_tree_grep` | Ripgrep search — stores matches as nodes |
| `ctx_tree_browse` | Fetch a URL — compact reference, stored as web_chunk |
| `ctx_tree_neighbors` | Walk the graph from a node |
| `ctx_tree_path_to_root` | Walk parent chain to root |

## Red Flags — STOP

- "I'll just read the file directly." — Use `ctx_tree_read`. Same content, builds the graph. The hook will block native Read anyway.
- "I already know this codebase." — Training memory is stale. Search first.
- "The store probably doesn't have this yet." — Search before assuming. Prior sessions may have it.
- "ctx_tree_compose seems like overkill." — Token budget pressure is exactly when compose matters most.
- "This bash command won't return much." — You can't know that before running it. Use `ctx_tree_grep` or `mcp_exec`.

## Rationalization Table

| Excuse | Reality |
|--------|---------|
| "Native Read is simpler." | `ctx_tree_read` does the same thing and builds the graph. |
| "I already know the codebase." | You know what was true at training cutoff. The store knows now. |
| "Search returned nothing." | Store may be sparse on first run — read the file, but use `ctx_tree_read`. |
| "This bash command is safe." | Unpredictable output size. Route through ctx-tree or mcp-exec. |
