---
name: recall
description: Use when starting work in a familiar codebase, recalling prior context or decisions, reading code files, searching for symbols or patterns, or building token-budget context for a complex task
---

# memtree recall

Core principle: The store knows what's true now. Training memory knows what was true when training ended. Always search the store before guessing.

## When To Use

- Starting any task in a codebase that has been worked in before
- Answering "what did we do with X" or "where is Y defined"
- Reading a file that may have been seen in a prior session
- Searching for a symbol, pattern, or concept across the codebase
- Building context for a complex task without blowing the token budget
- Orienting after a long gap or context compaction

## Tools

| Tool | Use when |
|------|----------|
| `memtree_recent` | Session start — surface what was captured in prior sessions |
| `memtree_search` | Keyword or concept lookup across all stored nodes |
| `memtree_compose` | Build a token-budget context bundle from seed nodes |
| `memtree_read` | Read a file — chunks via tree-sitter, caches on mtime, stores the result |
| `memtree_grep` | Ripgrep search — stores matches as nodes for future recall |
| `memtree_neighbors` | Walk the graph from a node to find related nodes |
| `memtree_path_to_root` | Walk the parent chain from a node to root |

## Process

### Session start
1. Call `memtree_recent` to see what was captured in prior sessions.
2. Call `memtree_search` with the task topic to surface relevant nodes.
3. Use `memtree_compose` with found node IDs to build a context bundle before reading files.

### During work
- Use `memtree_read` instead of native `Read` — same result, stored and indexed.
- Use `memtree_grep` instead of `Bash(rg ...)` — same result, stored and indexed.
- After a `memtree_search` hit, call `memtree_neighbors` to pull related nodes.

### When the store returns nothing
- Fall back to native tools.
- The native results will be captured automatically via the PostToolUse hook — future sessions will have them.

### Before claiming done on recall-dependent work
1. Identify what prior context was relied on.
2. Confirm it came from the store, not from a training-data guess.
3. If you guessed, search the store now to verify or correct.

## Red Flags — STOP

- "I'll just read the file directly, it's faster." — Use `memtree_read`. Same speed, builds the graph.
- "I don't need to search, I remember this codebase." — Training memory is stale. Search first.
- "The store probably doesn't have this yet." — Search before assuming. The PostToolUse hook has been running.
- "memtree_compose seems like overkill." — Token budget pressure is exactly when it matters most.
- "Search returned nothing so I'll skip the rest of the process." — Fall back to native tools; results get stored for next time.

## Rationalization Table

| Excuse | Reality |
|--------|---------|
| "Native Read is simpler." | `memtree_read` does the same thing and builds the graph for future recall. |
| "I already know the codebase." | You know what was true at training cutoff. The store knows what's true now. |
| "Search returned nothing." | The store may be sparse on first run — fall back, but don't skip the search. |
| "This is a one-off lookup." | One-off lookups compound into a full knowledge graph over sessions. |
