#!/usr/bin/env bun
/**
 * postinstall.ts — memtree MCP post-install check
 *
 * Verifies platform compatibility and warns if the `rg` (ripgrep) binary is
 * not available in PATH. Does NOT download any binaries — bun:sqlite is
 * built-in to Bun and tree-sitter natives are compiled by `bun install`.
 */

const SUPPORTED = new Set([
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
]);

const platform = `${process.platform}-${process.arch}`;

if (!SUPPORTED.has(platform)) {
  process.stderr.write(
    `memtree: unsupported platform "${platform}". ` +
      `Supported: ${[...SUPPORTED].join(", ")}\n`
  );
  process.exit(1);
}

// Check for rg (ripgrep) — required at runtime for code-search tools.
// Warn but do not fail: the user may install it separately.
const rg = Bun.spawnSync(["rg", "--version"]);
if (rg.exitCode !== 0) {
  process.stderr.write(
    "memtree: WARNING — `rg` (ripgrep) not found in PATH.\n" +
      "  memtree's code-search tools require ripgrep at runtime.\n" +
      "  Install it before using memtree:\n" +
      "    macOS:  brew install ripgrep\n" +
      "    Ubuntu: apt-get install ripgrep\n" +
      "    Arch:   pacman -S ripgrep\n" +
      "    Other:  https://github.com/BurntSushi/ripgrep#installation\n"
  );
}

process.stdout.write("memtree: postinstall complete\n");
