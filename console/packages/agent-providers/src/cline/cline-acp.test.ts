import { describe, expect, it } from 'vitest';
import { clineAcp, parseClineAuth } from './cline-acp';

describe('clineAcp hooks', () => {
  it('launches with --acp by default', () => {
    const launch = clineAcp.launch({
      binaryPath: 'cline',
      env: {},
    });
    expect(launch.command).toBe('cline');
    expect(launch.args).toEqual(['--acp']);
  });

  it('adds --auto-approve true when autoApprove is enabled', () => {
    const launch = clineAcp.launch({
      binaryPath: 'cline',
      env: {},
      autoApprove: true,
    });
    expect(launch.args).toEqual(['--acp', '--auto-approve', 'true']);
  });

  it('detects API key from environment', async () => {
    const check = await clineAcp.checkSignIn({
      binaryPath: 'cline',
      cwd: '/test',
      env: { CLINE_API_KEY: 'test-key' },
    });
    expect(check.status).toBe('authenticated');
  });

  it('parses unauthenticated status correctly', () => {
    const result = parseClineAuth('Not logged in. Please run cline auth to sign in.');
    expect(result.status).toBe('unauthenticated');
    expect(result.detail).toContain('cline auth');
  });

  it('parses authenticated status correctly', () => {
    const result = parseClineAuth('Authenticated as user@example.com');
    expect(result.status).toBe('authenticated');
  });
});
