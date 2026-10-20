import { describe, expect, it } from 'vitest';
import { bridgePlatformOfType, rememberBridgePlatforms } from './bridge-platform';

describe('bridgePlatformOfType', () => {
  it('reports the bundled platforms by name', () => {
    expect(bridgePlatformOfType('slack')).toBe('slack');
    expect(bridgePlatformOfType('teams')).toBe('teams');
  });

  it('reports a platform no server has listed as other', () => {
    expect(bridgePlatformOfType('zulip')).toBe('other');
  });

  it('reports a platform by name once a server lists it as registered', () => {
    rememberBridgePlatforms(['google_chat']);
    expect(bridgePlatformOfType('google_chat')).toBe('google_chat');
  });

  it('never learns a value that is not shaped like a platform key', () => {
    rememberBridgePlatforms(['someone@example.com', 'Has Spaces', 'x']);
    expect(bridgePlatformOfType('someone@example.com')).toBe('other');
    expect(bridgePlatformOfType('x')).toBe('other');
  });

  it('reports a missing type as unknown, not other', () => {
    expect(bridgePlatformOfType(null)).toBe('unknown');
    expect(bridgePlatformOfType('')).toBe('unknown');
  });
});
