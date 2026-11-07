import { describe, expect, it } from 'vitest';
import { aiderAcp } from './aider-adapter';
import { aiderLaunch, aiderSignedIn } from './runtime';

describe('aider provider hooks', () => {
  it('defines capabilities and launch configuration', async () => {
    expect(aiderAcp.provider).toBe('aider');
    expect(aiderAcp.defaultBinary).toBe('aider');
    expect(aiderAcp.capabilities.approvals).toBe(true);
    expect(aiderAcp.capabilities.resume).toBe(true);

    const launch = await aiderLaunch({
      binaryPath: '/usr/local/bin/aider',
      env: { FOO: 'bar' },
    });
    expect(launch.command).toBe('/usr/local/bin/aider');
    expect(launch.args).toEqual(['--acp']);
    expect(launch.env).toEqual({ FOO: 'bar' });
  });

  it('detects authentication via API keys', async () => {
    expect(await aiderSignedIn({})).toBe(false);
    expect(await aiderSignedIn({ OPENAI_API_KEY: 'sk-test' })).toBe(true);
    expect(await aiderSignedIn({ ANTHROPIC_API_KEY: 'sk-ant-test' })).toBe(true);
    expect(await aiderSignedIn({ DEEPSEEK_API_KEY: 'sk-deepseek-test' })).toBe(true);
  });

  it('maps runtime modes correctly', () => {
    expect(aiderAcp.sessionMode?.('full-access')).toBe('yolo');
    expect(aiderAcp.sessionMode?.('auto')).toBe('auto_edit');
    expect(aiderAcp.sessionMode?.('auto-accept-edits')).toBe('auto_edit');
    expect(aiderAcp.sessionMode?.('approval-required')).toBe('default');
  });
});
