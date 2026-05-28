import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Database } from 'bun:sqlite';
import { VisualizeServer } from '../../../../../mcp/src/visualize/server.js';
import { computeProjectHash } from '../../project-hash.js';

export async function serverStart(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      cwd:  { type: 'string' },
      port: { type: 'string' },
      open: { type: 'boolean', default: true },
    },
    strict: true,
  });

  const cwd = values.cwd ?? process.cwd();
  const port = parseInt(process.env.MEMTREE_VIZ_PORT ?? values.port ?? '', 10) || 7777;

  const hash = computeProjectHash(cwd);
  const memtreeHome = process.env.MEMTREE_HOME ?? join(homedir(), '.memtree');
  const dbPath = join(memtreeHome, hash, 'store.db');

  if (!existsSync(dbPath)) {
    console.error(`No memtree database found for this project.`);
    console.error(`Expected: ${dbPath}`);
    console.error(`Make sure the memtree MCP server has run in this project at least once.`);
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });
  const srv = new VisualizeServer(db, { port });
  const { url } = await srv.start();

  console.log(`memtree visualizer running at ${url}`);
  console.log(`Watching: ${dbPath}`);
  console.log(`Press Ctrl+C to stop.`);

  if (values.open !== false) {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawnSync(opener, [url], { stdio: 'ignore' });
  }

  const shutdown = () => srv.stop().then(() => { db.close(); process.exit(0); });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
