#!/usr/bin/env bun
import { spawnSync } from 'child_process';

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
const rg = spawnSync('rg', ['--version'], { stdio: 'pipe' });
if (rg.status !== 0) {
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
