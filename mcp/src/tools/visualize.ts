import { spawnSync } from 'node:child_process';
import type { Database } from 'bun:sqlite';
import { VisualizeServer } from '../visualize/server.js';

let vizServer: VisualizeServer | null = null;

export async function memtreeVisualize(
  db: Database,
  params: { port?: number; open?: boolean }
): Promise<{ url: string; port: number; nodeCount: number; edgeCount: number }> {
  if (!vizServer) {
    const port =
      parseInt(process.env.MEMTREE_VIZ_PORT ?? '', 10) || params.port ?? 7777;
    vizServer = new VisualizeServer(db, { port });
    await vizServer.start();
  }

  const { nodeCount, edgeCount } = vizServer.stats();

  if (params.open !== false) {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawnSync(opener, [vizServer.url], { stdio: 'ignore' });
  }

  return { url: vizServer.url, port: vizServer.port, nodeCount, edgeCount };
}
