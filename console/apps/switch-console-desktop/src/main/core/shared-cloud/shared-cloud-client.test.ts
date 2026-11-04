import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

// The v1/v2 switch: nothing is asked of `/shared-cloud/*` unless Core says hosted agents v2 is on.

const mocks = vi.hoisted(() => ({ v2: false, gatewayFetch: vi.fn() }));
vi.mock('electron', () => ({ app: { isPackaged: true } }));
vi.mock('./hosted-v2', () => ({ hostedV2On: async () => mocks.v2 }));
vi.mock('@main/core/switch-servers/gateway-client', () => ({
  GatewayError: class extends Error {},
  fetchManagedAgents: vi.fn(),
  gatewayFetch: mocks.gatewayFetch,
}));

const { fetchSharedCloudOverview, listSharedCloudAgents, mockCloudMachine } =
  await import('./shared-cloud-client');
const { cloudMachineSchema } = await import('@shared/core/cloud-agents/cloud-agents');
const server = { id: 'server-1' } as unknown as SwitchServer;

beforeEach(() => {
  mocks.v2 = false;
  mocks.gatewayFetch.mockReset();
});

describe('the shared-cloud client', () => {
  it('asks nothing and answers "no shared cloud" with hosted_v2 off', async () => {
    expect(await listSharedCloudAgents(server)).toBeNull();
    expect(await fetchSharedCloudOverview(server)).toBeNull();
    expect(mocks.gatewayFetch).not.toHaveBeenCalled();
  });

  it('asks Core with hosted_v2 on', async () => {
    mocks.v2 = true;
    mocks.gatewayFetch.mockResolvedValue({ json: async () => ({ available: true, agents: [] }) });
    expect(await listSharedCloudAgents(server)).toEqual([]);
    expect(mocks.gatewayFetch).toHaveBeenCalledWith(server, '/shared-cloud/agents', {
      authenticated: true,
    });
  });
});

describe('the dev-only mock box', () => {
  it('is listed as Core lists a box: the cloud machine schema, with backend "box"', () => {
    const machine = cloudMachineSchema.parse(mockCloudMachine());
    expect(machine.backend).toBe('box');
    expect(machine.controller_id).toBe('mock-shared-cloud-box');
  });
});
