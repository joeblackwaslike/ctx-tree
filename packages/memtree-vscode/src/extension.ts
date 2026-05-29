import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

interface VizInfo {
  url: string;
  port: number;
  nodeCount: number;
  edgeCount: number;
}

let activePanel: vscode.WebviewPanel | undefined;
let activeProc: cp.ChildProcess | undefined;

export function activate(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('memtree.openVisualizer', () => openVisualizer(ctx))
  );
}

export function deactivate(): void {
  activeProc?.kill();
  activeProc = undefined;
}

async function openVisualizer(ctx: vscode.ExtensionContext): Promise<void> {
  if (activePanel) {
    activePanel.reveal();
    return;
  }

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    vscode.window.showErrorMessage('memtree: no workspace folder open.');
    return;
  }

  let info: VizInfo;
  try {
    info = await startServer(root);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    const msg = e.code === 'ENOENT'
      ? 'memtree not found on PATH — install it with: npm install -g memtree'
      : `memtree failed to start: ${e.message}`;
    vscode.window.showErrorMessage(msg);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'memtree.visualizer',
    `memtree (${info.nodeCount} nodes)`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  panel.webview.html = buildHtml(ctx, info.port);
  activePanel = panel;

  panel.onDidDispose(() => {
    activeProc?.kill();
    activeProc = undefined;
    activePanel = undefined;
  }, null, ctx.subscriptions);
}

function findMemtreeBin(): Promise<string> {
  if (process.platform === 'win32') {
    return new Promise((resolve, reject) =>
      cp.exec('where memtree', { timeout: 5_000 }, (err, stdout) => {
        const p = stdout.split('\n')[0]?.trim();
        if (p) resolve(p); else reject(Object.assign(new Error('memtree not found'), { code: 'ENOENT' }));
      })
    );
  }
  const shell = process.env.SHELL || '/bin/zsh';
  return new Promise((resolve, reject) =>
    cp.exec(`${shell} -l -c 'which memtree 2>/dev/null'`, { timeout: 5_000 }, (err, stdout) => {
      const p = stdout.trim();
      if (p) resolve(p); else reject(Object.assign(new Error('memtree not found'), { code: 'ENOENT' }));
    })
  );
}

async function startServer(cwd: string): Promise<VizInfo> {
  const bin = await findMemtreeBin();
  return new Promise((resolve, reject) => {
    const child = cp.spawn(
      bin,
      ['viz', 'server', 'start', '--cwd', cwd, '--no-open', '--json'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    activeProc = child;

    let buf = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        try { resolve(JSON.parse(buf.slice(0, nl))); }
        catch (e) { reject(e); }
      }
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`memtree exited with code ${code ?? 'null'}`));
    });

    setTimeout(() => reject(new Error('memtree startup timed out after 15s')), 15_000);
  });
}

function buildHtml(ctx: vscode.ExtensionContext, port: number): string {
  const uiPath = path.join(ctx.extensionPath, 'media', 'ui.html');
  let html = fs.readFileSync(uiPath, 'utf8');

  const csp = [
    "default-src 'none'",
    "script-src 'unsafe-inline' https://cdn.jsdelivr.net",
    "style-src 'unsafe-inline'",
    `connect-src ws://127.0.0.1:${port} ws://localhost:${port}`,
    'img-src data:',
  ].join('; ');

  html = html.replace(
    '<head>',
    `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp};">`
  );
  html = html.replace(
    '</head>',
    `<script>globalThis.MEMTREE_WS_URL='ws://127.0.0.1:${port}/api/events';</script>\n</head>`
  );

  return html;
}
