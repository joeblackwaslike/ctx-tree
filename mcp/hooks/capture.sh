#!/usr/bin/env bash
set -euo pipefail

# TODO(v1.2): replace this shell pipeline with a compiled hook binary

MEMTREE_HOME="${MEMTREE_HOME:-${HOME}/.memtree}"

# Walk up from $MEMTREE_CWD to find nearest registered project root
HASH=""
DIR="${MEMTREE_CWD:-$PWD}"
PROJECTS_TSV="${MEMTREE_HOME}/projects.tsv"
while [[ "$DIR" != "/" ]]; do
  HASH=$(awk -F'\t' -v cwd="$DIR" '$1==cwd{print $2;exit}' \
    "$PROJECTS_TSV" 2>/dev/null || true)
  [[ -n "$HASH" ]] && break
  DIR="$(dirname "$DIR")"
done

[[ -z "$HASH" ]] && exit 0

SOCKET="${MEMTREE_HOME}/${HASH}/ingest.sock"
[[ ! -S "$SOCKET" ]] && exit 0

jq -cn \
  --arg tool       "$CLAUDE_TOOL_NAME" \
  --arg cwd        "$DIR" \
  --arg session_id "${CLAUDE_SESSION_ID:-}" \
  --argjson input    "${CLAUDE_TOOL_INPUT:-null}" \
  --argjson response "${CLAUDE_TOOL_RESPONSE:-null}" \
  '{tool:$tool,input:$input,response:$response,session_id:(if $session_id!="" then $session_id else null end),cwd:$cwd,ts:(now*1000|floor)}' \
| socat - "UNIX-CONNECT:${SOCKET}" &>/dev/null || true
