import { describe, test, expect } from 'bun:test';
import { redactBashOutput, shouldDropBashCommand, shouldDropPath } from './index';

describe('shouldDropBashCommand', () => {
  test('drops "env"', () => expect(shouldDropBashCommand('env')).toBe(true));
  test('drops "printenv HOME"', () => expect(shouldDropBashCommand('printenv HOME')).toBe(true));
  test('allows "echo hello"', () => expect(shouldDropBashCommand('echo hello')).toBe(false));
  test('allows "ls -la"', () => expect(shouldDropBashCommand('ls -la')).toBe(false));
});

describe('redactBashOutput', () => {
  test('redacts AWS access key', () => {
    const out = redactBashOutput('AKIAIOSFODNN7EXAMPLE is my key');
    expect(out).toContain('[REDACTED:AWS_ACCESS_KEY]');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  test('redacts GitHub token', () => {
    const out = redactBashOutput('token: ghp_abcdefghijklmnopqrstuvwxyz123456789');
    expect(out).toContain('[REDACTED:GITHUB_TOKEN]');
  });

  test('redacts JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abc123_signature';
    const out = redactBashOutput(`Authorization: Bearer ${jwt}`);
    expect(out).toContain('[REDACTED:JWT]');
  });

  test('redacts ANTHROPIC_API_KEY= line', () => {
    const out = redactBashOutput('export ANTHROPIC_API_KEY=sk-ant-abc123');
    expect(out).toContain('[REDACTED:ANTHROPIC_API_KEY]');
  });

  test('redacts OPENAI_API_KEY= line', () => {
    const out = redactBashOutput('OPENAI_API_KEY=sk-abcdef1234567890abcdef1234567890');
    expect(out).toContain('[REDACTED:OPENAI_API_KEY]');
  });

  test('passes through clean output unchanged', () => {
    const out = redactBashOutput('build succeeded in 3.2s');
    expect(out).toBe('build succeeded in 3.2s');
  });
});

describe('shouldDropPath', () => {
  test('drops .env files', () => expect(shouldDropPath('/project/.env')).toBe(true));
  test('drops .env.local', () => expect(shouldDropPath('/project/.env.local')).toBe(true));
  test('drops SSH private key', () => expect(shouldDropPath('/home/user/.ssh/id_rsa')).toBe(true));
  test('drops AWS credentials', () => expect(shouldDropPath('/home/user/.aws/credentials')).toBe(true));
  test('drops .pem file', () => expect(shouldDropPath('/certs/server.pem')).toBe(true));
  test('allows normal source file', () => expect(shouldDropPath('/project/src/index.ts')).toBe(false));
});
