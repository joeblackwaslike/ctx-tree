---
name: recall
description: Use when starting work in a familiar codebase, recalling prior context or decisions, reading code files, searching for symbols or patterns, or building token-budget context for a complex task
---

# memtree recall

Core principle: The store knows what's true now. Training memory knows what was true when training ended. Always search the store before guessing.

## Session Start Protocol

**Run this immediately when the session-start hook fires or when invoked at startup.**

Use the `AskUserQuestion` tool with exactly this question:

> It looks like you have memtree installed. Would you like to use memtree for this session?

Options:
- **Yes** — enable proxy mode (all reads/searches route through memtree/mcp-exec)
- **No** — skip memtree for this session
- **Maybe later** — skip for now, user can invoke this skill again
- **I don't know** — explain what memtree does, then ask again

If **Yes**: activate proxy mode immediately — run:
```bash
mkdir -p ~/.memtree && touch ~/.memtree/proxy-mode
```
Then confirm: "Proxy mode is active. I'll route reads and searches through memtree and mcp-exec to keep context slim."

If **No** or **Maybe later**: acknowledge and proceed normally. Do not ask again this session.

If **I don't know**: explain briefly —
> "memtree is a persistent knowledge store. It captures what I read and search across sessions so I can recall it without re-reading files. In proxy mode, I route every Read, Grep, Bash, and Glob through memtree or mcp-exec so only a small result comes back to this context window instead of the full output."

Then ask again.

---

## Proxy Mode — Tool Map

When proxy mode is active (after the user says Yes), use this table for **every tool call**:

| Instead of | Call this |
|------------|-----------|
| `Read(file_path: "X")` | `memtree_read({file_path: "X"})` |
| `Grep(pattern: "X", path: "Y")` | `memtree_grep({pattern: "X", path: "Y"})` |
| `Bash(command: "...")` | `mcp__mcp-exec__exec({code: "...", runtime: "bash"})` |
| `Glob(pattern: "X")` | `mcp__mcp-exec__exec({code: "find . -path 'X' \| sort \| head -200", runtime: "bash"})` |
| `Edit` / `Write` / `MultiEdit` | Native — write ops are fine, they return nothing large |

**The PreToolUse hook will remind you** with the exact rewritten call if you reach for a native tool. Read the reminder and use the rewritten version.

### Key rules in proxy mode
- `memtree_read` and `memtree_grep` store results in the knowledge graph — prefer them over mcp-exec for reads and searches.
- `mcp-exec` for bash keeps arbitrary command output out of context — use it for anything else.
- After `memtree_search` or `memtree_grep` returns nodes, call `memtree_neighbors` to pull related nodes.

---

## Non-Proxy Use (memtree tools without full proxy mode)

When proxy mode is off but you still want to use memtree for recall:

### Session start
1. Call `memtree_recent` — surface what was captured in prior sessions.
2. Call `memtree_search` with the task topic.
3. Use `memtree_compose` with found node IDs to build a context bundle.

### During work
- Prefer `memtree_read` over native `Read` — caches on mtime, indexes in graph.
- Prefer `memtree_grep` over native `Bash(rg ...)` — stores matches for future recall.
- After a search hit, call `memtree_neighbors` to find related nodes.

### Tool reference

| Tool | Use when |
|------|----------|
| `memtree_recent` | Session start — surface prior session captures |
| `memtree_search` | Keyword or concept lookup across all stored nodes |
| `memtree_compose` | Token-budget context bundle from seed nodes |
| `memtree_read` | Read a file — tree-sitter chunks, mtime cache, stored |
| `memtree_grep` | Ripgrep search — stores matches as nodes |
| `memtree_neighbors` | Walk the graph from a node |
| `memtree_path_to_root` | Walk parent chain to root |

---

## Red Flags — STOP

- "I'll just read the file directly, it's faster." — Use `memtree_read`. Same speed, builds the graph.
- "I don't need to search, I remember this codebase." — Training memory is stale. Search first.
- "The store probably doesn't have this yet." — Search before assuming. The PostToolUse hook has been running.
- "memtree_compose seems like overkill." — Token budget pressure is exactly when it matters most.
- "Proxy mode is on but this one tool call is fine." — It is not fine. The hook will remind you.

## Rationalization Table

| Excuse | Reality |
|--------|---------|
| "Native Read is simpler." | `memtree_read` does the same thing and builds the graph. |
| "I already know the codebase." | You know what was true at training cutoff. The store knows now. |
| "Search returned nothing." | Store may be sparse on first run — fall back, but don't skip the search. |
| "This bash command won't return much." | You cannot know that before running it. Use mcp-exec. |
