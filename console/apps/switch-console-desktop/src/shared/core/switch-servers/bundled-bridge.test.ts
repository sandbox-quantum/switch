import { describe, expect, it } from 'vitest';
import { bundledMattermostBridge, bundledMattermostBridgeId } from './bundled-bridge';
import type { RemoteBridge } from './switch-servers';

function bridge(overrides: Partial<RemoteBridge>): RemoteBridge {
  return {
    id: 'b1',
    type: 'mattermost',
    displayName: 'Mattermost',
    status: 'active',
    isDefault: false,
    preconfigured: null,
    homeUrl: null,
    channelCreationSupported: true,
    canCreateChannels: true,
    directorySearchSupported: true,
    attention: null,
    teamPlacementSupported: false,
    channelIdsRefused: null,
    receivesWebhooks: false,
    privateChannels: null,
    privateChannelNeedsLinkedAccount: false,
    webhookUrl: null,
    ...overrides,
  };
}

describe('bundledMattermostBridge', () => {
  it('picks the Mattermost bridge marked preconfigured over one the user connected', () => {
    const bridges = [
      bridge({ id: 'external', preconfigured: false }),
      bridge({ id: 'bundled', preconfigured: true }),
    ];

    expect(bundledMattermostBridgeId(bridges)).toBe('bundled');
    expect(bundledMattermostBridgeId([...bridges].reverse())).toBe('bundled');
  });

  it('ignores a preconfigured bridge of another platform', () => {
    const bridges = [
      bridge({ id: 'slack', type: 'slack', preconfigured: true }),
      bridge({ id: 'mm', preconfigured: null }),
    ];

    expect(bundledMattermostBridgeId(bridges)).toBe('mm');
  });

  it('takes the only Mattermost bridge on a server that predates the flag', () => {
    expect(bundledMattermostBridgeId([bridge({ id: 'mm', preconfigured: null })])).toBe('mm');
  });

  it('never takes a Mattermost bridge a person connected, even the only one', () => {
    expect(bundledMattermostBridge([bridge({ id: 'mm', preconfigured: false })])).toEqual({
      kind: 'none',
    });
  });

  it('reports no bridge when there is no Mattermost one', () => {
    expect(bundledMattermostBridge([bridge({ id: 'slack', type: 'slack' })])).toEqual({
      kind: 'none',
    });
    expect(bundledMattermostBridge([])).toEqual({ kind: 'none' });
  });

  it('refuses to guess between several unmarked Mattermost bridges', () => {
    const bridges = [
      bridge({ id: 'a', preconfigured: null }),
      bridge({ id: 'b', preconfigured: null }),
    ];

    expect(bundledMattermostBridge(bridges)).toEqual({ kind: 'ambiguous', bridgeIds: ['a', 'b'] });
    expect(bundledMattermostBridgeId(bridges)).toBeNull();
  });

  it('refuses to guess between several marked Mattermost bridges', () => {
    const bridges = [
      bridge({ id: 'a', preconfigured: true }),
      bridge({ id: 'b', preconfigured: true }),
    ];

    expect(bundledMattermostBridge(bridges)).toEqual({ kind: 'ambiguous', bridgeIds: ['a', 'b'] });
  });
});
