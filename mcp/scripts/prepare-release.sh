#!/usr/bin/env bash
# prepare-release.sh — build and optionally publish a ctx-tree GitHub release
#
# Usage:
#   ./scripts/prepare-release.sh <VERSION>          # build only
#   PUBLISH=1 ./scripts/prepare-release.sh <VERSION> # build + gh release create
#
# Requirements: bun, gh (optional, for publishing)

set -eu

VERSION="${1:?Usage: $0 <VERSION>  (e.g. 1.0.0)}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "ctx-tree: preparing release v${VERSION}"
echo "  Working directory: ${MCP_DIR}"

# ── Build ────────────────────────────────────────────────────────────────────
echo "ctx-tree: building server bundle..."
cd "$MCP_DIR"
bun build src/server.ts \
  --target bun \
  --outdir dist \
  --external tree-sitter \
  --external tree-sitter-typescript \
  --external tree-sitter-javascript \
  --external tree-sitter-python \
  --external tree-sitter-rust \
  --external tree-sitter-go \
  --external tree-sitter-bash

echo ""
echo "ctx-tree: build complete."
echo "  Artifact: dist/server.js"
echo ""
echo "  NOTE: dist/server.js is the only release artifact needed."
echo "  bun:sqlite is built-in to Bun — no native binary bundles required."
echo "  tree-sitter natives are compiled by 'bun install' on the user's machine."
echo ""

# ── Publish (opt-in) ─────────────────────────────────────────────────────────
if [[ "${PUBLISH:-}" == "1" ]]; then
  if ! command -v gh &>/dev/null; then
    echo "ERROR: gh CLI not found. Install it from https://cli.github.com/" >&2
    exit 1
  fi

  echo "ctx-tree: creating GitHub release v${VERSION}..."
  gh release create "v${VERSION}" \
    dist/server.js \
    --repo joeblackwaslike/ctx-tree \
    --title "v${VERSION}" \
    --generate-notes

  echo "ctx-tree: release v${VERSION} published."
else
  echo "  To publish: PUBLISH=1 $0 ${VERSION}"
fi
