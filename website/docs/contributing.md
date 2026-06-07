---
id: contributing
title: Contributing
sidebar_position: 9
---

# Contributing

## Setup

```sh
git clone https://github.com/joeblackwaslike/ctx-tree
cd ctx-tree
git config core.hooksPath .githooks   # auto-rebuilds dist on commit
bun install
```

The pre-commit hook builds the MCP server dist before each commit so the plugin always ships with compiled output.

## Project structure

```
ctx-tree/
├── .claude-plugin/
│   └── plugin.json        # Claude Code plugin manifest
├── hooks/                 # Claude Code hooks (10 .mjs files)
│   └── lib/               # Shared utilities (project-hash.mjs, db.mjs, etc.)
├── mcp/
│   ├── src/               # TypeScript MCP server source
│   │   ├── server.ts      # Entry point — MCP server + tool registration
│   │   ├── config.ts      # Config loading + merging
│   │   ├── project-hash.ts # Git-based project hash
│   │   ├── redaction/     # Output redaction regexes
│   │   ├── store/         # SQLite schema, node/edge CRUD, FTS
│   │   ├── tools/         # One file per MCP tool
│   │   └── walkers/       # Background maintenance routines
│   └── dist/              # Compiled output (committed; built by pre-commit hook)
├── website/               # This Docusaurus docs site
└── docs/                  # Source docs (design spec, interactive HTML viz)
```

## Building the MCP server

```sh
bun run build           # from repo root (via Bun workspace)
# or
cd mcp && bun run build
```

Output lands in `mcp/dist/`.

## Running locally

```sh
# Start the MCP server directly (for testing)
bun run mcp/dist/server.js

# Test via the plugin (in a Claude Code session)
/plugin reload ctx-tree
```

## Adding a new MCP tool

1. Create `mcp/src/tools/your-tool.ts` and export an async function
2. Import and register it in `mcp/src/server.ts` — add to both `ListToolsRequestSchema` handler and `CallToolRequestSchema` switch
3. Add a `case` to the switch in `server.ts`
4. Update [MCP Tools Reference](./reference/mcp-tools) in the docs

## Adding a new hook

1. Create `hooks/your-hook.mjs`
2. Add the hook to `.claude-plugin/plugin.json` under the appropriate event
3. Use `computeProjectHash(cwd)` from `hooks/lib/project-hash.mjs` for DB path resolution
4. Update [Hooks Reference](./reference/hooks) in the docs

## Code style

- TypeScript for all MCP server code (`mcp/src/`)
- ESM `.mjs` for all hooks (`hooks/`)
- No comments unless the WHY is non-obvious
- Match async/sync to the surrounding code

## Issues and PRs

Open issues at [github.com/joeblackwaslike/ctx-tree/issues](https://github.com/joeblackwaslike/ctx-tree/issues).

PRs welcome. For significant changes, open an issue first to discuss the approach.
