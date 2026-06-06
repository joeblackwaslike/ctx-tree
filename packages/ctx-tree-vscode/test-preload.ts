import { mock } from 'bun:test';

// The `vscode` module is only provided by the VSCode extension host at runtime;
// there is no installable npm package for it. extension.ts imports it at the top
// level, so we stub it here to allow unit-testing the pure helpers (e.g. patchHtml).
mock.module('vscode', () => ({}));
