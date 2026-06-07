import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { openDb, closeDb } from '../store/db.js';
import { insertNode } from '../store/nodes.js';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';

const CLI = join(import.meta.dir, '../../../packages/ctx-tree/src/cli.ts');

let tmpDir: string;
let db: Database;
let dbPath: string;
const procs: ReturnType<typeof Bun.spawn>[] = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ctx-tree-cli-e2e-'));
  dbPath = join(tmpDir, 'test.db');
  db = openDb(dbPath);
});

afterEach(async () => {
  for (const p of procs.splice(0)) {
    try { p.kill(); } catch { /* already exited */ }
  }
  closeDb(db);
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeNode(id = ulid()) {
  const content = 'cli e2e';
  insertNode(db, id, {
    parent_id: null,
    kind: 'note',
    source_uri: null,
    content,
    content_hash: createHash('sha256').update(content).digest('hex'),
    status: 'live',
    mtime: 0,
    truncated: 0,
    original_bytes: content.length,
    metadata: '{}',
  });
  return id;
}

async function readFirstLine(stream: ReadableStream<Uint8Array>, timeout = 8000): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';

  const line = await Promise.race([
    (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const nl = buf.indexOf('\n');
        if (nl !== -1) { reader.releaseLock(); return buf.slice(0, nl).trim(); }
      }
      reader.releaseLock();
      throw new Error('stream ended without newline');
    })(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('readFirstLine timeout')), timeout)
    ),
  ]);

  return line;
}

function spawnAttach(extraArgs: string[] = []) {
  const proc = Bun.spawn(
    ['bun', 'run', CLI, 'viz', 'server', 'attach', '--db', dbPath, '--json', ...extraArgs],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  procs.push(proc);
  return proc;
}

describe('ctx-tree CLI E2E — viz server attach', () => {
  test('--json outputs a valid JSON line with url, port, nodeCount, edgeCount', async () => {
    makeNode();
    const proc = spawnAttach();
    const line = await readFirstLine(proc.stdout);

    const info = JSON.parse(line);
    expect(typeof info.url).toBe('string');
    expect(info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
    expect(typeof info.port).toBe('number');
    expect(info.nodeCount).toBe(1);
    expect(info.edgeCount).toBe(0);
  });

  test('HTTP server responds to /health after --json startup', async () => {
    const proc = spawnAttach();
    const line = await readFirstLine(proc.stdout);
    const { url } = JSON.parse(line);

    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe('ok');
  });

  test('WebSocket delivers snapshot after --json startup', async () => {
    const id = makeNode();
    const proc = spawnAttach();
    const line = await readFirstLine(proc.stdout);
    const { url } = JSON.parse(line);

    const wsUrl = url.replace('http://', 'ws://') + '/api/events';

    const msg = await new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const t = setTimeout(() => reject(new Error('WS timeout')), 5000);
      ws.onmessage = (ev) => {
        clearTimeout(t);
        ws.close();
        resolve(JSON.parse(ev.data as string));
      };
      ws.onerror = () => reject(new Error('WS error'));
    });

    expect(msg.op).toBe('snapshot');
    expect(msg.nodes.some((n: any) => n.id === id)).toBe(true);
  });

  test('reports correct nodeCount for pre-populated db', async () => {
    makeNode();
    makeNode();
    makeNode();
    const proc = spawnAttach();
    const line = await readFirstLine(proc.stdout);
    const { nodeCount } = JSON.parse(line);
    expect(nodeCount).toBe(3);
  });

  test('exits non-zero when --db is missing', async () => {
    const proc = Bun.spawn(['bun', 'run', CLI, 'viz', 'server', 'attach', '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    procs.push(proc);
    const code = await proc.exited;
    expect(code).not.toBe(0);
  });

  test('exits non-zero when --db path does not exist', async () => {
    const proc = Bun.spawn(
      ['bun', 'run', CLI, 'viz', 'server', 'attach', '--db', '/nonexistent/path.db', '--json'],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    procs.push(proc);
    const code = await proc.exited;
    expect(code).not.toBe(0);
  });

  test('ctx-tree viz --help exits zero and prints usage', async () => {
    const proc = Bun.spawn(['bun', 'run', CLI, 'viz', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    procs.push(proc);
    const [code, text] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);
    expect(code).toBe(0);
    expect(text).toContain('ctx-tree viz');
  });
});
