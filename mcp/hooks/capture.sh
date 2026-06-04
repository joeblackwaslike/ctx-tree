#!/usr/bin/env bash
set -euo pipefail

# TODO: replace this shell pipeline with a compiled hook binary

CTX_TREE_HOME="${CTX_TREE_HOME:-${HOME}/.ctx-tree}"

# Walk up from $CTX_TREE_CWD to find nearest registered project root
HASH=""
DIR="${CTX_TREE_CWD:-$PWD}"
PROJECTS_TSV="${CTX_TREE_HOME}/projects.tsv"
while [[ "$DIR" != "/" ]]; do
  HASH=$(awk -F'\t' -v cwd="$DIR" '$1==cwd{print $2;exit}' \
    "$PROJECTS_TSV" 2>/dev/null || true)
  [[ -n "$HASH" ]] && break
  DIR="$(dirname "$DIR")"
done

[[ -z "$HASH" ]] && exit 0

SOCKET="${CTX_TREE_HOME}/${HASH}/ingest.sock"
[[ ! -S "$SOCKET" ]] && exit 0

_safe_json() { printf '%s' "${1:-null}" | jq '.' 2>/dev/null || printf 'null'; }

jq -cn \
  --arg tool       "$CLAUDE_TOOL_NAME" \
  --arg cwd        "$DIR" \
  --arg session_id "${CLAUDE_SESSION_ID:-}" \
  --argjson input    "$(_safe_json "${CLAUDE_TOOL_INPUT:-}")" \
  --argjson response "$(_safe_json "${CLAUDE_TOOL_RESPONSE:-}")" \
  '{tool:$tool,input:$input,response:$response,session_id:(if $session_id!="" then $session_id else null end),cwd:$cwd,ts:(now*1000|floor)}' \
| socat - "UNIX-CONNECT:${SOCKET}" &>/dev/null || true
