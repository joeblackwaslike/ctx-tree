export const BASH_DENY_COMMANDS: RegExp[] = [
  /^env(\s|$)/,
  /^printenv(\s|$)/,
  /\benv\s+/,
];

export const OUTPUT_REDACTION_PATTERNS: Array<{ pattern: RegExp; tag: string }> = [
  { pattern: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, tag: 'AWS_ACCESS_KEY' },
  { pattern: /\bgh[poshur]_[A-Za-z0-9_]{30,}\b/g, tag: 'GITHUB_TOKEN' },
  { pattern: /\bey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, tag: 'JWT' },
  { pattern: /(AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)=[^\s\n]+/gi, tag: 'AWS_SECRET' },
  { pattern: /ANTHROPIC_API_KEY=[^\s\n]+/gi, tag: 'ANTHROPIC_API_KEY' },
  { pattern: /OPENAI_API_KEY=[^\s\n]+/gi, tag: 'OPENAI_API_KEY' },
  {
    pattern: /\b(secret|token|password|key)\s*=\s*['"]?[A-Fa-f0-9]{32,}['"]?/gi,
    tag: 'SECRET_HEX',
  },
  {
    pattern: /\b(secret|token|password|key)\s*=\s*['"]?[A-Za-z0-9+/]{40,}={0,2}['"]?/gi,
    tag: 'SECRET_B64',
  },
];
