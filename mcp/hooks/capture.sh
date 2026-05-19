#!/usr/bin/env bash
set -euo pipefail

# TODO(v1.2): replace this shell pipeline with a compiled hook binary

# Walk up from $MEMTREE_CWD to find nearest registered project root
HASH=""
DIR="${MEMTREE_CWD:-$PWD}"
PROJECTS_TSV="${HOME}/.memtree/projects.tsv"
while [[ "$DIR" != "/" ]]; do
  HASH=$(awk -F'\t' -v cwd="$DIR" '$1==cwd{print $2;exit}' \
    "$PROJECTS_TSV" 2>/dev/null || true)
  [[ -n "$HASH" ]] && break
  DIR="$(dirname "$DIR")"
done

[[ -z "$HASH" ]] && exit 0

SOCKET="${HOME}/.memtree/${HASH}/ingest.sock"
[[ ! -S "$SOCKET" ]] && exit 0

SESSION_ID="${CLAUDE_SESSION_ID:-null}"
# Wrap session_id as a JSON string unless it's already null
if [[ "$SESSION_ID" != "null" ]]; then
  SESSION_ID="\"${SESSION_ID}\""
fi

jq -cn \
  --arg tool  "$CLAUDE_TOOL_NAME" \
  --arg cwd   "$MEMTREE_CWD" \
  --argjson session_id "$SESSION_ID" \
  --argjson input    "${CLAUDE_TOOL_INPUT:-null}" \
  --argjson response "${CLAUDE_TOOL_RESPONSE:-null}" \
  '{tool:$tool,input:$input,response:$response,session_id:$session_id,cwd:$cwd,ts:(now*1000|floor)}' \
| socat - "UNIX-CONNECT:${SOCKET}" &>/dev/null || true
