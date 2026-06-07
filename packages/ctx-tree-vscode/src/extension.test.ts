import { describe, test, expect } from 'bun:test';
import { patchHtml } from './extension.js';

const BASE_HTML = `<html><head><title>test</title></head><body><script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script><script>window.init();</script></body></html>`;
const NONCE = 'abc123';
const D3_URI = 'vscode-resource://media/d3.min.js';
const PORT = 7778;

describe('patchHtml', () => {
  test('CSP is injected after <head>', () => {
    const result = patchHtml(BASE_HTML, NONCE, D3_URI, PORT);
    expect(result).toContain('<meta http-equiv="Content-Security-Policy"');
  });

  test('script-src uses nonce, not unsafe-inline', () => {
    const result = patchHtml(BASE_HTML, NONCE, D3_URI, PORT);
    expect(result).toContain("script-src 'nonce-abc123'");

    // Isolate the script-src directive and ensure it has no unsafe-inline
    const match = result.match(/script-src[^;]*/);
    expect(match).not.toBeNull();
    expect(match![0]).not.toContain('unsafe-inline');
  });

  test('CDN D3 URL is replaced with d3Uri', () => {
    const result = patchHtml(BASE_HTML, NONCE, D3_URI, PORT);
    expect(result).toContain(D3_URI);
    expect(result).not.toContain('cdn.jsdelivr.net');
  });

  test('<script src= gets nonce', () => {
    const result = patchHtml(BASE_HTML, NONCE, D3_URI, PORT);
    expect(result).toContain('<script nonce="abc123" src=');
  });

  test('inline <script> gets nonce', () => {
    const result = patchHtml(BASE_HTML, NONCE, D3_URI, PORT);
    expect(result).toContain('<script nonce="abc123">');
  });

  test('WS URL is injected before </head>', () => {
    const result = patchHtml(BASE_HTML, NONCE, D3_URI, PORT);
    expect(result).toContain("CTX_TREE_WS_URL='ws://127.0.0.1:7778/api/events'");
  });

  test('nonce appears in WS injection script tag', () => {
    const result = patchHtml(BASE_HTML, NONCE, D3_URI, PORT);
    expect(result).toContain(
      `<script nonce="abc123">globalThis.CTX_TREE_WS_URL='ws://127.0.0.1:7778/api/events';</script>`
    );
  });
});
