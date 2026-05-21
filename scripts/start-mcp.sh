#!/usr/bin/env bash
set -euo pipefail

MCP_DIR="$(cd "$(dirname "$0")/../mcp" && pwd)"

if [ ! -d "$MCP_DIR/node_modules" ]; then
  bun install --cwd "$MCP_DIR" --frozen-lockfile 2>/dev/null || bun install --cwd "$MCP_DIR"
fi

exec bun "$MCP_DIR/src/server.ts"
