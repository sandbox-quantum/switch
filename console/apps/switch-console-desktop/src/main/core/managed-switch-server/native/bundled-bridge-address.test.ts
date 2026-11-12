import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteBridge, SwitchServer } from '@shared/core/switch-servers/switch-servers';

const fetchBridges = vi.hoisted(() => vi.fn());
const updateBridge = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());
vi.mock('@main/core/switch-servers/gateway-client', () => ({ fetchBridges, updateBridge }));
vi.mock('@main/lib/logger', () => ({
  log: { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { pointBundledMattermostBridgeAt } = await import('./bundled-bridge-address');

const SERVER = { id: 'srv-1', managed: true } as SwitchServer;
const URL = 'http://localhost:18065';
const CALLBACK = 'http://host.docker.internal:18000';

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

describe('pointBundledMattermostBridgeAt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateBridge.mockResolvedValue(undefined);
  });

  it('repoints the bundled bridge and leaves a Mattermost the user connected alone', async () => {
    fetchBridges.mockResolvedValue([
      bridge({ id: 'external', preconfigured: false }),
      bridge({ id: 'bundled', preconfigured: true }),
    ]);

    await pointBundledMattermostBridgeAt(SERVER, URL, CALLBACK);

    expect(updateBridge).toHaveBeenCalledTimes(1);
    expect(updateBridge).toHaveBeenCalledWith(SERVER, 'bundled', {
      connectionConfig: { url: URL, callback_base_url: CALLBACK },
    });
  });

  it('repoints the only Mattermost bridge on a server that predates the flag', async () => {
    fetchBridges.mockResolvedValue([bridge({ id: 'only', preconfigured: null })]);

    await pointBundledMattermostBridgeAt(SERVER, URL, CALLBACK);

    expect(updateBridge).toHaveBeenCalledWith(SERVER, 'only', expect.anything());
  });

  it('leaves the only Mattermost bridge alone when a person connected it', async () => {
    fetchBridges.mockResolvedValue([bridge({ id: 'external', preconfigured: false })]);

    await pointBundledMattermostBridgeAt(SERVER, URL, CALLBACK);

    expect(updateBridge).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('does nothing when there is no Mattermost bridge yet', async () => {
    fetchBridges.mockResolvedValue([bridge({ id: 'slack', type: 'slack' })]);

    await pointBundledMattermostBridgeAt(SERVER, URL, CALLBACK);

    expect(updateBridge).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('touches no bridge and warns when the bundled one cannot be told apart', async () => {
    fetchBridges.mockResolvedValue([
      bridge({ id: 'first', preconfigured: null }),
      bridge({ id: 'second', preconfigured: null }),
    ]);

    await pointBundledMattermostBridgeAt(SERVER, URL, CALLBACK);

    expect(updateBridge).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('first, second');
  });
});
