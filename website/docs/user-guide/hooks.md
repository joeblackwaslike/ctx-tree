---
id: hooks
title: Using the Hooks
sidebar_position: 4
---

# Using the Hooks

ctx-tree installs 10 Claude Code hooks automatically. You don't configure them — they fire on every relevant tool call and session event.

---

## Hook overview

| Event | Hook | What it does |
| ----- | ---- | ------------ |
| `SessionStart` | `session-start.mjs` | Injects tool guide and redirect reminders |
| `UserPromptSubmit` | `userpromptsubmit-capture.mjs` | Stores each prompt as a `prompt` node |
| `Stop` | `stop-response-capture.mjs` | Stores `thinking` + `response` nodes with full edge chain |
| `PreToolUse` | `pretooluse-redirect.mjs` | Blocks Read/Grep/WebFetch/Bash(grep/cat) → ctx-tree equivalent |
| `PreToolUse` | `pretooluse-agent-enrich.mjs` | Enriches Agent prompts with FTS context hits |
| `PreToolUse` | `pretooluse-skill-recall.mjs` | Returns cached skill node on cache hit |
| `PreToolUse` | `pretooluse-proxy.mjs` | Soft advisory mode (when `~/.ctx-tree/proxy-mode` flag is set) |
| `PostToolUse` | `posttooluse-agent-capture.mjs` | Creates summary node for completed Agent calls |
| `PostToolUse` | `posttooluse-skill-capture.mjs` | Stores Skill output as `skill://name` node |
| `PostToolUse` | `posttooluse-websearch-capture.mjs` | Browses and stores WebSearch result URLs in background |

---

## Tool redirect hook

`pretooluse-redirect.mjs` is the core hook. It fires on `Read`, `Grep`, `WebFetch`, `Bash` (when the command contains grep/cat/rg), `PowerShell`, and `Monitor`. It:

1. Blocks the native tool call (returns `{ "decision": "block" }`)
2. Injects a `hookSpecificOutput.additionalContext` message telling Claude which ctx-tree tool to use instead and with what parameters

This ensures raw tool output never enters the context window, even if Claude forgets to use a ctx-tree tool directly.

---

## Conversation capture hooks

### userpromptsubmit-capture.mjs

Fires on every non-empty user prompt. Stores the prompt text as a `prompt` node and wires a `follows` edge to the previous `response` node in the session. Deduplicates by content hash — the same prompt twice only creates one node.

Injects a context note so Claude knows the `nodeId` and can reference it when composing context for subagents.

### stop-response-capture.mjs

Fires when Claude finishes responding. Reads the session transcript (via `CLAUDE_TRANSCRIPT_PATH`) and stores:
- A `thinking` node for any thinking/reasoning content
- A `response` node for the assistant response text
- `follows` edges: response → prompt
- `derived_from` edges: response → all nodes referenced during that turn

---

## Agent hooks

### pretooluse-agent-enrich.mjs

Before an `Agent` tool call fires, this hook:
1. Extracts search terms from the agent's prompt
2. Runs `ctx_tree_search` against the store
3. Injects the top node IDs and a compact tool map into the subagent's prompt

Subagents start with context awareness of what the parent session has already read and stored.

### posttooluse-agent-capture.mjs

After an `Agent` completes, this hook:
1. Reads the agent's output and tool use list
2. Creates a `summary` node
3. Wires `summarizes` edges to every node the subagent touched

---

## Skill hooks

### pretooluse-skill-recall.mjs

Before a `Skill` invocation, checks if the skill's content is already stored as a `skill://name` node. On a cache hit, returns the stored node directly — the skill doesn't need to be re-loaded. On a miss, passes through and stores the result afterward.

### posttooluse-skill-capture.mjs

After a `Skill` completes, stores the skill content under its canonical `skill://name` URI.

---

## WebSearch hook

### posttooluse-websearch-capture.mjs

After a `WebSearch` completes, queues the result URLs for background browsing via `ctx_tree_browse`. The URLs are fetched and stored as `web_chunk` nodes asynchronously — they're available for recall in subsequent turns or future sessions without consuming context now.

---

## Proxy mode

Set `~/.ctx-tree/proxy-mode` (any content) to activate soft advisory mode via `pretooluse-proxy.mjs`. In this mode, the hook **nudges without blocking** — it injects a suggestion to use the ctx-tree equivalent but lets the native tool call proceed. Useful for debugging or gradual adoption.

Remove the file to return to blocking mode.
