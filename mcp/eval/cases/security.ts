import type { Database } from 'bun:sqlite';
import { ctxTreeRead } from '../../src/tools/read';
import { shouldDropPath, shouldDropBashCommand, redactBashOutput } from '../../src/redaction';
import type { CtxTreeConfig } from '../../src/store/types';
import { DEFAULT_CONFIG } from '../../src/config';

export interface SecurityResult {
  name: string;
  passed: boolean;
  error?: string;
}

const LEAKY_BASH_PAYLOADS = [
  { command: 'env', output: 'HOME=/Users/joe\nANTHROPIC_API_KEY=sk-ant-abc123secret\n' },
  { command: 'printenv', output: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n' },
  { command: 'echo $TOKEN', output: 'AKIAIOSFODNN7EXAMPLE\n' },
  { command: 'cat .env', output: 'OPENAI_API_KEY=sk-abcdefghij1234567890abcdefghij1234567890\n' },
  { command: 'curl -H auth', output: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.abc_sig\n' },
];

const SECRET_FILE_PATHS = [
  '/home/user/.env',
  '/project/.env.local',
  '/home/user/.aws/credentials',
  '/home/user/.ssh/id_rsa',
  '/certs/server.pem',
  '/keys/service-account.json',
];

export async function runSecurityCases(db: Database): Promise<SecurityResult[]> {
  const cfg: CtxTreeConfig = { ...DEFAULT_CONFIG };
  const results: SecurityResult[] = [];

  for (const { command, output } of LEAKY_BASH_PAYLOADS) {
    const dropped = shouldDropBashCommand(command);
    const redacted = redactBashOutput(output);
    const secretsGone = !redacted.includes('sk-') && !redacted.includes('AKIAIO') &&
      !redacted.includes('wJalrX') && !redacted.includes('eyJhbG');
    const passed = dropped || secretsGone;
    results.push({ name: `bash-redact:${command}`, passed,
      error: passed ? undefined : `Secret leaked in redacted output` });
  }

  for (const filePath of SECRET_FILE_PATHS) {
    let passed = false;
    let error: string | undefined;
    try {
      await ctxTreeRead(db, cfg, { path: filePath, budget_tokens: 200 });
      error = `Expected rejection for ${filePath} but got a result`;
    } catch (e: unknown) {
      passed = String((e as Error).message).includes('Path rejected by denylist');
      if (!passed) error = `Wrong error: ${(e as Error).message}`;
    }
    results.push({ name: `path-drop:${filePath}`, passed, error });
  }

  return results;
}
