import { describe, expect, it } from 'vitest';
import {
  SWITCH_CONSOLE_RELEASES_URL,
  switchConsoleReleaseApiUrl,
  switchConsoleReleaseTag,
  switchConsoleReleaseUrl,
} from './urls';

describe('switchConsoleReleaseTag', () => {
  it('namespaces the tag with the switch-console prefix', () => {
    expect(switchConsoleReleaseTag('0.18.2')).toBe('switch-console-v0.18.2');
  });

  it('does not double the v when the version already carries one', () => {
    expect(switchConsoleReleaseTag('v0.18.2')).toBe('switch-console-v0.18.2');
  });

  it('keeps a prerelease identifier intact', () => {
    expect(switchConsoleReleaseTag('0.19.0-canary.4')).toBe('switch-console-v0.19.0-canary.4');
  });
});

describe('switchConsoleReleaseUrl', () => {
  it('links to the namespaced release tag', () => {
    expect(switchConsoleReleaseUrl('0.18.2')).toBe(
      'https://github.com/sandbox-quantum/switch/releases/tag/switch-console-v0.18.2'
    );
  });

  it('falls back to the releases index when the version is unknown', () => {
    expect(switchConsoleReleaseUrl(undefined)).toBe(SWITCH_CONSOLE_RELEASES_URL);
  });
});

describe('switchConsoleReleaseApiUrl', () => {
  it('points at the namespaced tag on the API host', () => {
    expect(switchConsoleReleaseApiUrl('0.18.2')).toBe(
      'https://api.github.com/repos/sandbox-quantum/switch/releases/tags/switch-console-v0.18.2'
    );
  });
});
