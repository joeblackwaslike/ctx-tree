#!/usr/bin/env bun

const HELP = `
memtree — CLI for the memtree context store

USAGE
  memtree <command> [subcommand] [options]

COMMANDS
  viz server start    Find the memtree DB for the current project,
                      start the visualizer, and open the browser.
  viz server attach   Start the visualizer against an explicit DB path.
                      Designed for the VS Code extension (--json mode).

Run memtree <command> --help for details.
`.trim();

const [, , group, ...rest] = process.argv;

if (!group || group === '--help' || group === '-h') {
  console.log(HELP);
  process.exit(0);
}

if (group === 'viz') {
  await runViz(rest);
} else {
  console.error(`Unknown command: ${group}\n\n${HELP}`);
  process.exit(1);
}

async function runViz(args: string[]): Promise<void> {
  const VIZ_HELP = `
memtree viz — real-time graph visualizer for the memtree context store

USAGE
  memtree viz server start   [--cwd <dir>] [--port <n>] [--no-open]
  memtree viz server attach  --db <path>   [--port <n>] [--no-open] [--json]

COMMANDS
  server start    Find the memtree DB for the current project, start the
                  HTTP+WebSocket server, and open the browser.

  server attach   Start the server against an explicit database path.
                  For VS Code: --json writes {"url","port","nodeCount","edgeCount"}
                  to stdout then stays running silently.

OPTIONS (server start)
  --cwd <dir>     Project root to resolve the DB from (default: cwd)
  --port <n>      Port to bind (default: 7777 or $MEMTREE_VIZ_PORT)
  --no-open       Don't open the browser

OPTIONS (server attach)
  --db <path>     Path to the SQLite database file (required)
  --port <n>      Port to bind (default: 7777 or $MEMTREE_VIZ_PORT)
  --no-open       Don't open the browser
  --json          Output JSON to stdout then stay running silently
`.trim();

  const [subgroup, subcommand, ...subArgs] = args;

  if (!subgroup || subgroup === '--help' || subgroup === '-h') {
    console.log(VIZ_HELP);
    process.exit(0);
  }

  if (subgroup !== 'server') {
    console.error(`Unknown viz subcommand: ${subgroup}\n\n${VIZ_HELP}`);
    process.exit(1);
  }

  if (subcommand === 'start') {
    const { serverStart } = await import('./commands/viz/server-start.js');
    await serverStart(subArgs);
  } else if (subcommand === 'attach') {
    const { serverAttach } = await import('./commands/viz/server-attach.js');
    await serverAttach(subArgs);
  } else {
    console.error(`Unknown server subcommand: ${subcommand ?? '(none)'}\n\n${VIZ_HELP}`);
    process.exit(1);
  }
}
