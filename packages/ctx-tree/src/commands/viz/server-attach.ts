import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Database } from 'bun:sqlite';
import { VisualizeServer } from '../../../../../mcp/src/visualize/server.js';

export async function serverAttach(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      db:   { type: 'string' },
      port: { type: 'string' },
      open: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
    strict: true,
  });

  if (!values.db) {
    console.error('ctx-tree viz server attach requires --db <path>\n');
    console.error('Usage: ctx-tree viz server attach --db <path> [--port <n>] [--json]');
    process.exit(1);
  }

  if (!existsSync(values.db)) {
    console.error(`Database not found: ${values.db}`);
    process.exit(1);
  }

  const port = parseInt(process.env.CTX_TREE_VIZ_PORT ?? values.port ?? '', 10) || 7777;

  const db = new Database(values.db, { readonly: true });
  const srv = new VisualizeServer(db, { port });
  const { url, port: boundPort } = await srv.start();
  const { nodeCount, edgeCount } = srv.stats();

  if (values.json) {
    // Single JSON line to stdout then stay silent — VS Code extension reads this
    process.stdout.write(JSON.stringify({ url, port: boundPort, nodeCount, edgeCount }) + '\n');
  } else {
    console.log(`ctx-tree visualizer running at ${url}`);
    console.log(`Database: ${values.db}`);
    if (values.open) {
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
      spawnSync(opener, [url], { stdio: 'ignore' });
    }
    console.log(`Press Ctrl+C to stop.`);
  }

  const shutdown = () => srv.stop().then(() => { db.close(); process.exit(0); });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
