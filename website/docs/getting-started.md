---
id: getting-started
title: Getting Started
sidebar_position: 3
---

# Getting Started

After [installation](./installation), ctx-tree works immediately with zero configuration. This guide walks through your first session.

---

## First session

Start a new Claude Code session in any project. The SessionStart hook fires and injects the tool guide automatically — Claude knows which tools to use instead of the native ones.

### Reading a file

Instead of `Read`, Claude will use `ctx_tree_read`:

```
> Read the main server file
```

Claude calls `ctx_tree_read({ path: "src/server.ts" })` and gets back:

```json
{
  "nodeId": "01HXXXXXXXXXXXXXXXXXXXXXX",
  "path": "src/server.ts",
  "cached": false,
  "chunks": 4,
  "hint": "Call ctx_tree_compose([\"01HXX...\"], 4000) to retrieve content within budget"
}
```

The file is stored in the graph. The context window received ~60 tokens instead of ~4,200.

### Searching

Instead of `Grep`, Claude uses `ctx_tree_grep`:

```
> Find all exports from the store module
```

```json
{
  "matches": ["01HXX... src/store/nodes.ts:12", "01HXX... src/store/edges.ts:8"],
  "pattern": "export",
  "count": 2
}
```

### Recalling content

To read the actual content of stored nodes within a token budget:

```
> Compose the server file with a 4000 token budget
```

Claude calls `ctx_tree_compose(["01HXX..."], 4000)` and gets back the file content, chunked and scored to fit the budget.

---

## Cross-session recall

After the first session, those reads are persisted. Open a new session next week and the file is already in the graph:

```
> Search for anything we've read about the store module
```

Claude calls `ctx_tree_search({ query: "store nodes edges" })` and gets back the previously stored nodes — **zero tokens spent re-reading**.

---

## Key tools to know

| Tool | When to use |
| ---- | ----------- |
| `ctx_tree_read` | Read any file (replaces `Read`) |
| `ctx_tree_grep` | Search file content (replaces `Grep`) |
| `ctx_tree_browse` | Fetch a URL (replaces `WebFetch`) |
| `ctx_tree_compose` | Retrieve stored node content within a token budget |
| `ctx_tree_search` | Keyword search across all stored nodes |
| `ctx_tree_recent` | Surface nodes from prior sessions on re-entry |
| `ctx_tree_note` | Store an observation or decision for later recall |

---

## Tips

**Orient on session re-entry:** Use `ctx_tree_recent` to see what was read last session before diving in:

```
> What did we work on last session?
```

**Store decisions:** Use `ctx_tree_note` to persist observations that don't live in files:

```
> Note: the auth middleware is intentionally synchronous due to passport.js constraints
```

**Check the graph:** Use `ctx_tree_neighbors` to explore what's linked to a node — callers, imports, siblings.

---

## Next steps

- [How it works](./user-guide/how-it-works) — full architecture walkthrough
- [MCP Tools reference](./reference/mcp-tools) — complete tool documentation
- [Hooks reference](./reference/hooks) — what each hook intercepts
