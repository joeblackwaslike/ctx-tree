import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as crypto from 'crypto';
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
    vscode.commands.registerCommand('ctx-tree.openVisualizer', () => openVisualizer(ctx))
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
    vscode.window.showErrorMessage('ctx-tree: no workspace folder open.');
    return;
  }

  let info: VizInfo;
  try {
    info = await startServer(root);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    const msg = e.code === 'ENOENT'
      ? 'ctx-tree not found on PATH — install it with: npm install -g ctx-tree'
      : `ctx-tree failed to start: ${e.message}`;
    vscode.window.showErrorMessage(msg);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'ctx-tree.visualizer',
    `ctx-tree (${info.nodeCount} nodes)`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  panel.webview.html = buildHtml(ctx, panel.webview, info.port);
  activePanel = panel;

  panel.onDidDispose(() => {
    activeProc?.kill();
    activeProc = undefined;
    activePanel = undefined;
  }, null, ctx.subscriptions);
}

function findCtxTreeBin(): Promise<string> {
  if (process.platform === 'win32') {
    return new Promise((resolve, reject) =>
      cp.exec('where ctx-tree', { timeout: 5_000 }, (err, stdout) => {
        const p = stdout.split('\n')[0]?.trim();
        if (p) resolve(p); else reject(Object.assign(new Error('ctx-tree not found'), { code: 'ENOENT' }));
      })
    );
  }
  const shell = process.env.SHELL || '/bin/zsh';
  return new Promise((resolve, reject) =>
    cp.exec(`${shell} -l -c 'which ctx-tree 2>/dev/null'`, { timeout: 5_000 }, (err, stdout) => {
      const p = stdout.trim();
      if (p) resolve(p); else reject(Object.assign(new Error('ctx-tree not found'), { code: 'ENOENT' }));
    })
  );
}

async function startServer(cwd: string): Promise<VizInfo> {
  const bin = await findCtxTreeBin();
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
      if (code !== 0) reject(new Error(`ctx-tree exited with code ${code ?? 'null'}`));
    });

    setTimeout(() => reject(new Error('ctx-tree startup timed out after 15s')), 15_000);
  });
}

function buildHtml(ctx: vscode.ExtensionContext, webview: vscode.Webview, port: number): string {
  const nonce = crypto.randomBytes(16).toString('hex');

  const d3Uri = webview.asWebviewUri(
    vscode.Uri.joinPath(ctx.extensionUri, 'media', 'd3.min.js')
  );

  const uiPath = path.join(ctx.extensionPath, 'media', 'ui.html');
  let html = fs.readFileSync(uiPath, 'utf8');

  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    `connect-src ws://127.0.0.1:${port} ws://localhost:${port}`,
    'img-src data:',
  ].join('; ');

  html = html.replace(
    '<head>',
    `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp};">`
  );

  // Replace CDN D3 URL with local vscode-resource URI and add nonce
  html = html.replace(
    'https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js',
    d3Uri.toString()
  );
  html = html.replaceAll(
    '<script src=',
    `<script nonce="${nonce}" src=`
  );

  // Add nonce to all inline <script> blocks
  html = html.replaceAll(
    '<script>',
    `<script nonce="${nonce}">`
  );

  // Inject WS URL global with nonce before </head>
  html = html.replace(
    '</head>',
    `<script nonce="${nonce}">globalThis.CTX_TREE_WS_URL='ws://127.0.0.1:${port}/api/events';</script>\n</head>`
  );

  return html;
}
