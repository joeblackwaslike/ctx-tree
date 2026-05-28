---
id: installation
title: Installation
sidebar_position: 2
---

# Installation

memtree installs as a Claude Code plugin via the [agent marketplace](https://github.com/joeblackwaslike/agent-marketplace). One command installs the MCP server, all 10 hooks, and pre-configures skills.

---

## Requirements

| Requirement | Version | Install |
| ----------- | ------- | ------- |
| macOS or Linux | arm64 or x64 | — |
| [Bun](https://bun.sh) | ≥1.1 | See below |
| [ripgrep](https://github.com/BurntSushi/ripgrep) | ≥13 | See below |

```sh
# macOS
brew install bun ripgrep

# Linux (Debian/Ubuntu)
curl -fsSL https://bun.sh/install | bash
apt install ripgrep
```

---

## Install via marketplace

```sh
# Step 1 — Add the marketplace (one-time global setup)
/plugin marketplace add joeblackwaslike/agent-marketplace

# Step 2 — Install memtree
/plugin install memtree@agent-marketplace
```

The installer:
- Registers the `memtree` MCP server
- Registers the `mcp-exec` MCP server (sandboxed execution)
- Installs all 10 hooks (SessionStart, PreToolUse, PostToolUse, UserPromptSubmit, Stop)
- Configures skills for tool redirect guidance

Start a new Claude Code session after install. Every tool call is already being intercepted.

---

## Verify installation

In a new session, run:

```
> Tell me what MCP tools you have available
```

You should see `memtree_read`, `memtree_grep`, `memtree_compose`, and the other memtree tools listed. The SessionStart hook will also inject a tool guide into Claude's context automatically.

To verify the graph is working:

```
> Use memtree_read to read the README.md file
```

The response should return a compact `nodeId` reference, not the raw file contents.

---

## Manual install (advanced)

If you prefer not to use the marketplace, add the following to your Claude Code MCP config manually:

```json
{
  "mcpServers": {
    "memtree": {
      "command": "/usr/bin/env",
      "args": ["bun", "run", "/path/to/memtree/mcp/dist/server.js"]
    }
  }
}
```

And add the hooks from `.claude-plugin/hooks/` to your Claude Code hooks config.

---

## Uninstall

```sh
/plugin uninstall memtree@agent-marketplace
```

This removes all hooks and MCP server registrations. The graph data at `~/.memtree/` is left intact — delete it manually if you want to wipe the store.
