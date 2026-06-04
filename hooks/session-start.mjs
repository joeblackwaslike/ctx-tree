#!/usr/bin/env node
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));

// Only inject on fresh startup and resume — skip compact/clear noise
const hookEvent = String(input.hook_event_name ?? '');
if (hookEvent && hookEvent !== 'startup' && hookEvent !== 'resume') {
  process.stdout.write('{}');
  process.exit(0);
}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: `\
## ctx-tree is active

ctx-tree is a persistent graph store for codebase and web content. Every read and search this session builds a navigation graph you can traverse without re-reading files.

**Always-on redirects (hooks enforce these automatically):**
- Use \`ctx_tree_read\` instead of \`Read\` — same content, symbol-chunked nodes stored in graph
- Use \`ctx_tree_grep\` instead of \`Grep\` or \`Bash(rg/grep/cat)\` — same results, stored as nodes
- Use \`ctx_tree_browse\` instead of \`WebFetch\` — compact reference returned, page stored as node
- Use \`mcp__mcp-exec__exec({code, runtime})\` instead of \`Bash\` for arbitrary shell commands — sandboxed, only final output enters context

**Graph navigation (use after any read/grep):**
- \`ctx_tree_neighbors(nodeId)\` — find related code: callers, imports, same-module siblings
- \`ctx_tree_search(query)\` — keyword search across all stored nodes this session + prior sessions
- \`ctx_tree_compose(nodeIds, budget_tokens)\` — assemble a focused context slice without re-reading
- \`ctx_tree_recent()\` — surface what was captured in prior sessions

**Workflow:** read → get nodeIds → neighbors → compose. Build the graph as you work; revisit without re-reading.`,
  },
}));
