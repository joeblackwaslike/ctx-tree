import micromatch from 'micromatch';
import { BASH_DENY_COMMANDS, OUTPUT_REDACTION_PATTERNS } from './bash';
import { DEFAULT_PATH_DENY_GLOBS } from './paths';

export function shouldDropBashCommand(command: string, extraPatterns: RegExp[] = []): boolean {
  const all = [...BASH_DENY_COMMANDS, ...extraPatterns];
  return all.some(re => re.test(command));
}

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
