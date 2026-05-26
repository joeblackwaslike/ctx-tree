#!/usr/bin/env node
/**
 * PreToolUse hook — hard-redirects native Read/Grep/Bash/WebFetch to memtree
 * equivalents. Emits permissionDecision:deny so the original call is blocked,
 * then injects the exact replacement call as additionalContext.
 */

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.fs', '.fsx',
  '.sh', '.bash', '.zsh', '.fish',
  '.yaml', '.yml', '.json', '.jsonc', '.toml', '.hcl', '.tf', '.tfvars',
  '.graphql', '.gql', '.proto', '.sql',
  '.css', '.scss', '.sass', '.less',
  '.html', '.svelte', '.vue',
  '.md', '.mdx', '.rst',
]);

const GREP_COMMANDS = new Set(['grep', 'rg', 'ag', 'egrep', 'fgrep', 'ack', 'ripgrep']);
const CAT_COMMANDS  = new Set(['cat', 'bat']);

function getExt(filePath) {
  const dot = filePath.lastIndexOf('.');
  return dot >= 0 ? filePath.slice(dot).toLowerCase() : '';
}

function deny(reason, context) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
      additionalContext: context,
    },
  }));
  process.exit(0);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const toolName  = String(input.tool_name  ?? '').toLowerCase();
const toolInput = input.tool_input ?? {};

// ── Read ──────────────────────────────────────────────────────────────────────
if (toolName === 'read') {
  const filePath = String(toolInput.file_path ?? toolInput.filePath ?? '');
  if (filePath && CODE_EXTENSIONS.has(getExt(filePath))) {
    const extra = toolInput.lines
      ? `, lines: ${JSON.stringify(toolInput.lines)}`
      : '';
    deny(
      `Use memtree_read instead of Read for "${filePath}".`,
      `Call: memtree_read({ path: ${JSON.stringify(filePath)}${extra} })\n\nReturns identical content. Also symbol-chunks the file, stores nodes in the session graph, and returns nodeIds you can pass to memtree_neighbors to find related code.`,
    );
  }
}

// ── Grep ──────────────────────────────────────────────────────────────────────
if (toolName === 'grep') {
  const pattern = String(toolInput.pattern ?? toolInput.regex ?? '');
  const path    = String(toolInput.path ?? toolInput.include ?? '');
  const pathArg = path ? `, path: ${JSON.stringify(path)}` : '';
  deny(
    `Use memtree_grep instead of Grep.`,
    `Call: memtree_grep({ pattern: ${JSON.stringify(pattern)}${pathArg} })\n\nSame ripgrep results. Stores each match as a graph node so you can revisit via memtree_search or memtree_neighbors without re-running the search.`,
  );
}

// ── Bash ──────────────────────────────────────────────────────────────────────
if (toolName === 'bash') {
  const command = String(toolInput.command ?? '').trim();

  // Skip piped / compound commands — too risky to partially intercept
  if (command.includes('|') || command.includes(';') || command.includes('&&')) {
    process.exit(0);
  }

  const parts   = command.split(/\s+/);
  const cmdName = parts[0].split('/').pop().toLowerCase();

  if (GREP_COMMANDS.has(cmdName)) {
    // Extract a best-effort pattern + path from the grep command
    const nonFlagArgs = parts.slice(1).filter(p => !p.startsWith('-'));
    const pattern = nonFlagArgs[0] ?? '';
    const searchPath = nonFlagArgs[1] ?? '.';
    deny(
      `Use memtree_grep instead of ${cmdName}.`,
      `Call: memtree_grep({ pattern: ${JSON.stringify(pattern)}, path: ${JSON.stringify(searchPath)} })\n\nSame results, stored as graph nodes.`,
    );
  }

  if (CAT_COMMANDS.has(cmdName)) {
    const filePath = parts.slice(1).find(p => !p.startsWith('-')) ?? '';
    if (filePath && CODE_EXTENSIONS.has(getExt(filePath))) {
      deny(
        `Use memtree_read instead of ${cmdName} for "${filePath}".`,
        `Call: memtree_read({ path: ${JSON.stringify(filePath)} })\n\nReturns the file content and stores symbol-chunked nodes in the session graph.`,
      );
    }
  }
}

// ── WebFetch ──────────────────────────────────────────────────────────────────
if (toolName === 'webfetch') {
  const url = String(toolInput.url ?? toolInput.uri ?? '');
  deny(
    `Use memtree_browse instead of WebFetch for "${url}".`,
    `Call: memtree_browse({ url: ${JSON.stringify(url)} })\n\nReturns a compact structured reference (title, key sections, nodeId) instead of raw HTML. Stores the page as a web_chunk node so you can revisit via memtree_neighbors or memtree_search.`,
  );
}

// ── WebSearch ─────────────────────────────────────────────────────────────────
// Not blocked — search results are compact already and we have no memtree
// replacement yet. PostToolUse hook handles compaction once results arrive.
// (memtree_web_search is a future tool)

// No redirect needed — allow the call
process.exit(0);
