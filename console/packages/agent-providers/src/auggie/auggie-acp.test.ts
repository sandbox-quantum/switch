import { describe, expect, it } from 'vitest';
import { auggieAcp, parseAuggieStatus } from './auggie-acp';

describe('auggieAcp hooks', () => {
  it('launches with --acp flag', () => {
    const launch = auggieAcp.launch({
      binaryPath: 'auggie',
      env: {},
    });
    expect(launch.command).toBe('auggie');
    expect(launch.args).toEqual(['--acp']);
  });

  it('detects AUGMENT_API_KEY from environment', async () => {
    const check = await auggieAcp.checkSignIn({
      binaryPath: 'auggie',
      cwd: '/test',
      env: { AUGMENT_API_KEY: 'test-key' },
    });
    expect(check.status).toBe('authenticated');
  });

  it('parses unauthenticated status correctly', () => {
    const result = parseAuggieStatus('Not authenticated. Run auggie login to authenticate.');
    expect(result.status).toBe('unauthenticated');
    expect(result.detail).toContain('auggie login');
  });

  it('parses authenticated status correctly', () => {
    const result = parseAuggieStatus('Authenticated with Augment Code');
    expect(result.status).toBe('authenticated');
  });
});
