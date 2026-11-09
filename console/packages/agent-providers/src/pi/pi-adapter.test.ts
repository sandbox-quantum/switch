import { describe, expect, it } from 'vitest';
import { piAcp } from './pi-adapter';
import { piLaunch, piSignedIn } from './runtime';

describe('pi provider hooks', () => {
  it('defines capabilities and launch configuration', async () => {
    expect(piAcp.provider).toBe('pi');
    expect(piAcp.defaultBinary).toBe('pi');
    expect(piAcp.loginCommand).toBe('pi login');
    expect(piAcp.capabilities.approvals).toBe(true);
    expect(piAcp.capabilities.resume).toBe(true);

    const launch = await piLaunch({
      binaryPath: '/usr/local/bin/pi',
      env: { FOO: 'bar' },
    });
    expect(launch.command).toBe('/usr/local/bin/pi');
    expect(launch.args).toEqual(['--mode', 'acp']);
    expect(launch.env).toEqual({ FOO: 'bar' });
  });

  it('detects authentication via API keys', async () => {
    expect(await piSignedIn({})).toBe(false);
    expect(await piSignedIn({ ANTHROPIC_API_KEY: 'sk-ant-test' })).toBe(true);
    expect(await piSignedIn({ OPENAI_API_KEY: 'sk-proj-test' })).toBe(true);
  });

  it('maps runtime modes correctly', () => {
    expect(piAcp.sessionMode?.('full-access')).toBe('yolo');
    expect(piAcp.sessionMode?.('auto')).toBe('auto_edit');
    expect(piAcp.sessionMode?.('auto-accept-edits')).toBe('auto_edit');
    expect(piAcp.sessionMode?.('approval-required')).toBe('default');
  });
});
