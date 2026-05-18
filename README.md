# memtree

External, persistent, tree/graph-shaped context store for Claude Code sessions.

## What it does

Indexes files and search results in a local SQLite store when you use memtree-backed MCP tools. Exposes tools for surgical recall — read a function body, search across sessions, compose a token-budget context bundle.

**v1.1:** Adds a PostToolUse hook for passive capture of native Read/Grep/Bash outputs.

## Install

```sh
/plugin install memtree@agent-marketplace
```

## Requirements

- macOS arm64, Linux x64/arm64
- Bun ≥1.1 (`curl -fsSL https://bun.sh/install | bash`)
- `rg ≥13` (`brew install ripgrep` / `apt install ripgrep`)

## Tools

| Tool | Description |
|------|-------------|
| `memtree_read` | Read file with tree-sitter chunking + mtime cache |
| `memtree_grep` | Ripgrep search, results stored |
| `memtree_search` | FTS5 keyword search across store |
| `memtree_compose` | Budget-bounded context bundle from seed nodes |
| `memtree_neighbors` | Graph walk from node |
| `memtree_path_to_root` | Walk parent chain to root |
| `memtree_recent` | Recently captured nodes |
