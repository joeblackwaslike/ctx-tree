---
name: using-memtree
description: Use memtree MCP tools to reduce token usage and context rot for any task involving file reads, search, or recall
---

Use memtree's MCP tools whenever token savings, context control, or recall across tool calls would be valuable. This applies broadly — not only to large codebases or long sessions.

## Tools

- `memtree_read` — read a file with symbol-level chunking; use `budget_tokens` to cap output
- `memtree_grep` — search with ripgrep; results stored as graph nodes for future recall
- `memtree_search` — keyword search across all previously captured content
- `memtree_compose` — assemble a context bundle from seed node IDs within a token budget
- `memtree_neighbors` — walk edges and parent relationships from a known node
- `memtree_recent` — retrieve recently captured nodes
- `memtree_path_to_root` — walk the parent chain from any node up to the root

## When to reach for memtree

Any of these signals is enough:

- **Token savings matter** — you want to limit how much context a file read or search consumes
- **Mitigate context rot** — you're in a long session and earlier reads are being pushed out
- **Strict output control** — you need precise control over what intermediate tool results land in context
- **Cross-tool recall** — you want to revisit a file or search result captured earlier without re-running the tool
- **Graph relationships** — you want to traverse edges between captures (file → grep match → related file)

Specific patterns:

- File already read this session → `memtree_search` or `memtree_compose` on the cached node
- Need a function body without loading the whole file → `memtree_read` with `lines` + `budget_tokens`
- Pattern search you may need to revisit → `memtree_grep` (stores results as nodes)
- Assembling context for a prompt from multiple prior captures → `memtree_compose`

## Fallback

Use native `Read`/`Grep` only when you need the full, untruncated output in context immediately and won't need to recall it later.
