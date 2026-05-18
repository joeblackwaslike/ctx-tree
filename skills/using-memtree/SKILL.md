---
name: using-memtree
description: Use memtree MCP tools for budget-bounded file reads, search, and recall in large codebases or long sessions
---

Use memtree's MCP tools instead of native Read/Grep when working in a large codebase or long session:

- `memtree_read` — read a file with symbol-level chunking; use `budget_tokens` to cap output
- `memtree_grep` — search with ripgrep; results stored for future recall
- `memtree_search` — keyword search across all previously captured content
- `memtree_compose` — assemble a context bundle from seed node IDs within a token budget
- `memtree_neighbors` — walk edges and parent relationships from a known node
- `memtree_recent` — retrieve recently captured nodes

**When to use memtree over native tools:**
- File you've already read this session → `memtree_search` or `memtree_compose` on the cached node
- Need a function body without loading the whole file → `memtree_read` with `budget_tokens`
- Pattern search where you'll need to revisit results → `memtree_grep`

**Fallback:** Use native `Read`/`Grep` when you need the full, untruncated output in context.
