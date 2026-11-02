import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

// The v1/v2 switch, per server: each server's own `hosted_v2` decides, so one
// server with v2 on never turns v2 on for another.

const mocks = vi.hoisted(() => ({
  current: vi.fn(async (server: { id: string }) => ({
    serverId: server.id,
    flags: { hosted_v2: server.id === 'server-a' },
    fetchedAt: 1,
    error: null,
  })),
  gatewayFetch: vi.fn(),
}));
vi.mock('electron', () => ({ app: { isPackaged: true } }));
vi.mock('@main/core/feature-flags/feature-flags', () => ({
  featureFlagsService: { current: mocks.current },
}));
vi.mock('@main/core/switch-servers/gateway-client', () => ({
  GatewayError: class extends Error {},
  fetchManagedAgents: vi.fn(),
  gatewayFetch: mocks.gatewayFetch,
}));

const { hostedV2On } = await import('./hosted-v2');
const { listSharedCloudAgents } = await import('./shared-cloud-client');
const serverA = { id: 'server-a' } as unknown as SwitchServer;
const serverB = { id: 'server-b' } as unknown as SwitchServer;

beforeEach(() => {
  mocks.current.mockClear();
  mocks.gatewayFetch.mockReset();
  mocks.gatewayFetch.mockResolvedValue({ json: async () => ({ available: true, agents: [] }) });
});

describe('hosted_v2, server by server', () => {
  it("reads each server's own flag", async () => {
    expect(await hostedV2On(serverA)).toBe(true);
    expect(await hostedV2On(serverB)).toBe(false);
    expect(mocks.current).toHaveBeenNthCalledWith(1, serverA);
    expect(mocks.current).toHaveBeenNthCalledWith(2, serverB);
  });

  it("asks server B nothing while server A has v2 on, after looking up B's own flag", async () => {
    expect(await listSharedCloudAgents(serverA)).toEqual([]);
    expect(await listSharedCloudAgents(serverB)).toBeNull();
    expect(mocks.current).toHaveBeenCalledWith(serverB);
    expect(mocks.gatewayFetch).toHaveBeenCalledTimes(1);
    expect(mocks.gatewayFetch).toHaveBeenCalledWith(serverA, '/shared-cloud/agents', {
      authenticated: true,
    });
  });
});
