import { describe, expect, it } from 'vitest';
import { openhandsAcp, parseOpenhandsStatus } from './openhands-acp';

describe('openhandsAcp hooks', () => {
  it('launches with acp subcommand', () => {
    const launch = openhandsAcp.launch({
      binaryPath: 'openhands',
      env: {},
    });
    expect(launch.command).toBe('openhands');
    expect(launch.args).toEqual(['acp']);
  });

  it('adds --auto-approve true when autoApprove is enabled', () => {
    const launch = openhandsAcp.launch({
      binaryPath: 'openhands',
      env: {},
      autoApprove: true,
    });
    expect(launch.args).toEqual(['acp', '--auto-approve', 'true']);
  });

  it('detects OPENHANDS_API_KEY from environment', async () => {
    const check = await openhandsAcp.checkSignIn({
      binaryPath: 'openhands',
      cwd: '/test',
      env: { OPENHANDS_API_KEY: 'test-key' },
    });
    expect(check.status).toBe('authenticated');
  });

  it('parses unauthenticated status correctly', () => {
    const result = parseOpenhandsStatus('Error: not configured. Please run openhands login');
    expect(result.status).toBe('unauthenticated');
    expect(result.detail).toContain('openhands login');
  });

  it('parses configured status correctly', () => {
    const result = parseOpenhandsStatus('OpenHands CLI v0.10.0 (ready)');
    expect(result.status).toBe('authenticated');
  });
});
