#!/usr/bin/env node
import { readFileSync } from 'fs';

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
const { hook_event_name } = input;

// Only prompt on fresh startup, not resume/compact/clear
if (hook_event_name && hook_event_name !== 'startup') {
  process.stdout.write('{}');
  process.exit(0);
}

const output = {
  hookSpecificOutput: {
    additionalContext: `[memtree] You have the memtree plugin installed. Invoke the \`memtree:recall\` skill **now**, before doing anything else, to ask the user if they want to use memtree for this session.`,
  },
};

process.stdout.write(JSON.stringify(output));
