import micromatch from 'micromatch';
import { DEFAULT_PATH_DENY_GLOBS } from './paths';

// Bash command filtering is handled by the SRT sandbox (same sandbox as Claude Code),
// which reuses ~/.claude/settings.json permissions. No need to reimplement here.

const OUTPUT_REDACTION_PATTERNS: Array<{ pattern: RegExp; tag: string }> = [
  { pattern: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, tag: 'AWS_ACCESS_KEY' },
  { pattern: /\bgh[poshur]_[A-Za-z0-9_]{30,}\b/g, tag: 'GITHUB_TOKEN' },
  { pattern: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, tag: 'JWT' },
  { pattern: /(AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)=[^\s\n]+/gi, tag: 'AWS_SECRET' },
  { pattern: /ANTHROPIC_API_KEY=[^\s\n]+/gi, tag: 'ANTHROPIC_API_KEY' },
  { pattern: /OPENAI_API_KEY=[^\s\n]+/gi, tag: 'OPENAI_API_KEY' },
  { pattern: /\b(secret|token|password|key)\s*=\s*['"]?[A-Fa-f0-9]{32,}['"]?/gi, tag: 'SECRET_HEX' },
  { pattern: /\b(secret|token|password|key)\s*=\s*['"]?[A-Za-z0-9+/]{40,}={0,2}['"]?/gi, tag: 'SECRET_B64' },
];



export function redactBashOutput(output: string): string {
  let result = output;
  for (const { pattern, tag } of OUTPUT_REDACTION_PATTERNS) {
    result = result.replace(pattern, `[REDACTED:${tag}]`);
  }
  return result;
}

export function shouldDropPath(filePath: string, extraGlobs: string[] = []): boolean {
  const allGlobs = [...DEFAULT_PATH_DENY_GLOBS, ...extraGlobs];
  const basename = filePath.split('/').pop() ?? '';
  return micromatch.isMatch(filePath, allGlobs) || micromatch.isMatch(basename, allGlobs);
}
