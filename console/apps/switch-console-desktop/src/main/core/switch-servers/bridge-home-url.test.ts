import { describe, expect, it } from 'vitest';
import type { RemoteBridge } from '@shared/core/switch-servers/switch-servers';
import { withResolvedHomeUrls } from './bridge-home-url';

function bridge(overrides: Partial<RemoteBridge>): RemoteBridge {
  return {
    id: 'b1',
    type: 'slack',
    displayName: 'Slack',
    status: 'active',
    isDefault: true,
    homeUrl: null,
    channelCreationSupported: true,
    canCreateChannels: true,
    directorySearchSupported: true,
    attention: null,
    teamPlacementSupported: false,
    channelIdsRefused: null,
    receivesWebhooks: false,
    webhookUrl: null,
    ...overrides,
  };
}

describe('withResolvedHomeUrls', () => {
  it('puts a Slack workspace link in web form', () => {
    // `slack://` reaches nobody on a machine without the desktop app, which is
    // the same defect the per-room channel action had.
    const [resolved] = withResolvedHomeUrls([
      bridge({ id: 'b2', type: 'slack', homeUrl: 'slack://open?team=T1' }),
    ]);

    expect(resolved.homeUrl).toBe('https://app.slack.com/client/T1');
  });

  it('leaves a platform that already hands out a web link alone', () => {
    // Discord and Teams use https URLs their apps claim, so there is nothing to
    // translate and they must not become a special case.
    const resolved = withResolvedHomeUrls([
      bridge({ id: 'b3', type: 'discord', homeUrl: 'https://discord.com/channels/123' }),
      bridge({ id: 'b4', type: 'teams', homeUrl: null }),
    ]);

    expect(resolved[0].homeUrl).toBe('https://discord.com/channels/123');
    expect(resolved[1].homeUrl).toBeNull();
  });
});
