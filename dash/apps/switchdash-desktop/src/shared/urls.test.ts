import { describe, expect, it } from 'vitest';
import {
  SWITCHDASH_RELEASES_URL,
  switchdashReleaseApiUrl,
  switchdashReleaseTag,
  switchdashReleaseUrl,
} from './urls';

describe('switchdashReleaseTag', () => {
  it('namespaces the tag with the switchdash prefix', () => {
    expect(switchdashReleaseTag('0.18.2')).toBe('switchdash-v0.18.2');
  });

  it('does not double the v when the version already carries one', () => {
    expect(switchdashReleaseTag('v0.18.2')).toBe('switchdash-v0.18.2');
  });

  it('keeps a prerelease identifier intact', () => {
    expect(switchdashReleaseTag('0.19.0-canary.4')).toBe('switchdash-v0.19.0-canary.4');
  });
});

describe('switchdashReleaseUrl', () => {
  it('links to the namespaced release tag', () => {
    expect(switchdashReleaseUrl('0.18.2')).toBe(
      'https://github.com/sandbox-quantum/switch/releases/tag/switchdash-v0.18.2'
    );
  });

  it('falls back to the releases index when the version is unknown', () => {
    expect(switchdashReleaseUrl(undefined)).toBe(SWITCHDASH_RELEASES_URL);
  });
});

describe('switchdashReleaseApiUrl', () => {
  it('points at the namespaced tag on the API host', () => {
    expect(switchdashReleaseApiUrl('0.18.2')).toBe(
      'https://api.github.com/repos/sandbox-quantum/switch/releases/tags/switchdash-v0.18.2'
    );
  });
});
