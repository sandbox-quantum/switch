import { describe, expect, it } from 'vitest';
import type { RemoteBridge } from '@shared/core/switch-servers/switch-servers';
import { orderBridges } from './messaging-apps-order';

function bridge(id: string, displayName: string): RemoteBridge {
  return {
    id,
    type: 'slack',
    displayName,
    status: 'active',
    isDefault: false,
    homeUrl: null,
    channelCreationSupported: true,
    canCreateChannels: true,
    directorySearchSupported: true,
  };
}

describe('the order messaging apps are listed in', () => {
  it('does not depend on the order the gateway sent them', () => {
    // The same four apps as two different responses. Toggling a row refetches
    // the list, so if the order tracked the response the table would reshuffle
    // under the cursor of whoever just clicked.
    const first = [
      bridge('b1', 'Slack Test'),
      bridge('b2', 'Mattermost'),
      bridge('b3', 'Telegram'),
      bridge('b4', 'Discord'),
    ];
    const second = [first[2], first[0], first[3], first[1]];

    expect(orderBridges(first).map((b) => b.id)).toEqual(orderBridges(second).map((b) => b.id));
  });

  it('separates apps that share a display name, rather than letting them swap', () => {
    const sent = [bridge('b2', 'test'), bridge('b1', 'test')];
    expect(orderBridges(sent).map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(orderBridges([...sent].reverse()).map((b) => b.id)).toEqual(['b1', 'b2']);
  });

  it('leaves the caller’s list alone', () => {
    const sent = [bridge('b1', 'Zulip'), bridge('b2', 'Discord')];
    orderBridges(sent);
    expect(sent.map((b) => b.id)).toEqual(['b1', 'b2']);
  });
});
