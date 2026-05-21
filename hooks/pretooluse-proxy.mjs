#!/usr/bin/env node
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
const { tool_name, tool_input } = input;

const proxyFlag = join(homedir(), '.memtree', 'proxy-mode');
if (!existsSync(proxyFlag)) {
  process.stdout.write('{}');
  process.exit(0);
}

const rewrite = buildRewrite(tool_name, tool_input);
if (!rewrite) {
  process.stdout.write('{}');
  process.exit(0);
}

const output = {
  hookSpecificOutput: {
    additionalContext: [
      `[memtree proxy] Do NOT call \`${tool_name}\` directly — proxy mode is active.`,
      `Call this instead:\n`,
      rewrite,
    ].join('\n'),
  },
};

process.stdout.write(JSON.stringify(output));

function buildRewrite(toolName, input) {
  switch (toolName) {
    case 'Read':
      return [
        `memtree_read({`,
        `  file_path: ${JSON.stringify(input.file_path)},`,
        `})`,
      ].join('\n');

    case 'Grep':
      return [
        `memtree_grep({`,
        `  pattern: ${JSON.stringify(input.pattern)},`,
        input.path ? `  path: ${JSON.stringify(input.path)},` : null,
        `})`,
      ].filter(Boolean).join('\n');

    case 'Bash':
      return [
        `mcp__mcp-exec__exec({`,
        `  code: ${JSON.stringify(input.command)},`,
        `  runtime: "bash",`,
        `})`,
      ].join('\n');

    case 'Glob':
      return [
        `mcp__mcp-exec__exec({`,
        `  code: ${JSON.stringify(`find . -path '${input.pattern}' | sort | head -200`)},`,
        `  runtime: "bash",`,
        `})`,
      ].join('\n');

    // Edit / Write / MultiEdit pass through — write ops, no context bloat
    default:
      return null;
  }
}
