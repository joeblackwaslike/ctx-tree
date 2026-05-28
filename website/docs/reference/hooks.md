---
id: hooks
title: Hooks Reference
sidebar_position: 3
---

# Hooks Reference

Complete reference for all 10 memtree hooks. All hooks are installed automatically by the marketplace installer.

---

## Hook input format

All Claude Code hooks receive a JSON object on stdin. Common fields:

```typescript
{
  session_id: string;
  cwd: string;
  tool_name?: string;    // PreToolUse / PostToolUse
  tool_input?: object;   // PreToolUse / PostToolUse
  tool_response?: object; // PostToolUse
  prompt?: string;       // UserPromptSubmit
}
```

---

## Hook output format

Hooks write JSON to stdout. Relevant fields:

```typescript
{
  // Block a tool call (PreToolUse only):
  decision?: 'block';
  reason?: string;

  // Inject context into Claude's window:
  hookSpecificOutput?: {
    additionalContext: string;
  };

  // Continue with modifications (PostToolUse):
  continue?: boolean;
}
```

---

## SessionStart hooks

### session-start.mjs

**Trigger:** Session startup and resume

Writes a compact tool guide to `hookSpecificOutput.additionalContext` reminding Claude to use memtree tools instead of native ones. Includes the full redirect map and example calls.

No DB writes. Fires on every session start.

---

## UserPromptSubmit hooks

### userpromptsubmit-capture.mjs

**Trigger:** Every non-empty user prompt submission

1. Reads `input.prompt`
2. Deduplicates by `sha256(content)` — no duplicate nodes for the same prompt
3. Inserts a `prompt` node with:
   - `source_uri: prompt://<hash-prefix>`
   - `metadata: { session_id, title, cwd, turn_index }`
4. Wires a `follows` edge: `prompt → previous_response` (if one exists this session)
5. Returns `nodeId` in `additionalContext` for subagent context building

---

## Stop hooks

### stop-response-capture.mjs

**Trigger:** Every assistant response completion

Reads `CLAUDE_TRANSCRIPT_PATH` for the session transcript. For the latest assistant turn:

1. Extracts thinking content → `thinking` node
2. Extracts response content → `response` node
3. Wires edges:
   - `response → prompt` (follows)
   - `response → nodes_referenced_this_turn` (derived_from)
   - `thinking → response` (derived_from)

---

## PreToolUse hooks

### pretooluse-redirect.mjs

**Trigger:** `Read | Grep | Bash | WebFetch | PowerShell | Monitor`

For each matched tool:

| Native tool | Condition | Redirects to |
| ----------- | --------- | ------------ |
| `Read` | any | `memtree_read({ path, lines })` |
| `Grep` | any | `memtree_grep({ pattern, path, ... })` |
| `Bash` | command contains grep/rg/cat | `memtree_grep` or `memtree_read` |
| `WebFetch` | any | `memtree_browse({ url })` |
| `Monitor` | any | `memtree_monitor({ command })` |
| `PowerShell` | command contains grep/cat | `memtree_grep` or `memtree_read` |

Returns `{ decision: "block" }` + `hookSpecificOutput.additionalContext` with the redirect instruction.

### pretooluse-agent-enrich.mjs

**Trigger:** `Agent`

1. Extracts keywords from the agent prompt
2. Queries `memtree_search` for relevant stored nodes
3. Appends to the agent's prompt:
   - Top 5 matching node IDs with excerpts
   - A compact tool map of available memtree tools

Passes through (does not block the Agent call).

### pretooluse-skill-recall.mjs

**Trigger:** `Skill`

Checks for a stored `skill://name` node matching the skill being invoked. On cache hit, blocks the native Skill call and returns the stored content directly. On miss, passes through.

### pretooluse-proxy.mjs

**Trigger:** `Read | Grep | Bash | WebFetch` (only when `~/.memtree/proxy-mode` file exists)

Soft advisory mode. Does **not** block the native tool. Injects a suggestion to use the memtree equivalent. Remove `~/.memtree/proxy-mode` to disable.

---

## PostToolUse hooks

### posttooluse-agent-capture.mjs

**Trigger:** `Agent` (after completion)

Reads the agent's output and tool use list. Creates a `summary` node. Wires `summarizes` edges to every node the subagent touched.

### posttooluse-skill-capture.mjs

**Trigger:** `Skill` (after completion)

Stores the Skill output content as a `skill://name` node for instant recall on the next invocation.

### posttooluse-websearch-capture.mjs

**Trigger:** `WebSearch` (after completion)

Queues all result URLs for background browsing via `memtree_browse`. URLs are processed asynchronously — the hook returns immediately without waiting. Results are available for recall in subsequent turns or future sessions.

---

## Project hash algorithm

All hooks and the MCP server must agree on the same `~/.memtree/<project-hash>/` path. The hash is computed as:

```javascript
const gitRoot = execSync('git rev-parse --show-toplevel', { cwd }).toString().trim();
const firstCommit = execSync('git rev-list --max-parents=0 HEAD', { cwd }).toString().trim();
const hash = sha256(`${gitRoot}:${firstCommit}`).slice(0, 16);
// Fallback: sha256(cwd).slice(0, 16) if not a git repo
```

Hooks import this from `hooks/lib/project-hash.mjs`. The MCP server implements the same algorithm in `mcp/src/project-hash.ts`.
