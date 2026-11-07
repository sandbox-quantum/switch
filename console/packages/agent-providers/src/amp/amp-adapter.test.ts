import { describe, expect, it } from 'vitest';
import { ampAcp } from './amp-adapter';
import { ampLaunch, ampSignedIn } from './runtime';

describe('amp provider hooks', () => {
  it('defines capabilities and launch configuration', async () => {
    expect(ampAcp.provider).toBe('amp');
    expect(ampAcp.defaultBinary).toBe('amp');
    expect(ampAcp.loginCommand).toBe('amp login');
    expect(ampAcp.capabilities.approvals).toBe(true);
    expect(ampAcp.capabilities.resume).toBe(true);

    const launch = await ampLaunch({
      binaryPath: '/usr/local/bin/amp',
      env: { FOO: 'bar' },
    });
    expect(launch.command).toBe('/usr/local/bin/amp');
    expect(launch.args).toEqual(['acp']);
    expect(launch.env).toEqual({ FOO: 'bar' });
  });

  it('detects authentication via API keys', async () => {
    expect(await ampSignedIn({})).toBe(false);
    expect(await ampSignedIn({ AMP_API_KEY: 'amp_test_key' })).toBe(true);
    expect(await ampSignedIn({ SOURCEGRAPH_TOKEN: 'sgp_test_token' })).toBe(true);
  });

  it('maps runtime modes correctly', () => {
    expect(ampAcp.sessionMode?.('full-access')).toBe('yolo');
    expect(ampAcp.sessionMode?.('auto')).toBe('auto_edit');
    expect(ampAcp.sessionMode?.('auto-accept-edits')).toBe('auto_edit');
    expect(ampAcp.sessionMode?.('approval-required')).toBe('default');
  });
});
