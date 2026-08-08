import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@shared/core/agents/agents';
import type { Location } from '@shared/core/locations/locations';
import { agentsStore } from './agents-store';
import { type LocationStore } from './location';
import { LocationManagerStore } from './location-manager';

const mocks = vi.hoisted(() => ({
  onboardAgent: vi.fn(),
  getAgents: vi.fn(async () => [] as Agent[]),
  deleteAgent: vi.fn(async () => {}),
  getLocations: vi.fn(async () => [] as Location[]),
  inspectLocationPath: vi.fn(),
  openLocation: vi.fn(),
  eventOn: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: {
    on: mocks.eventOn,
  },
  rpc: {
    agents: {
      onboardAgent: mocks.onboardAgent,
      getAgents: mocks.getAgents,
      deleteAgent: mocks.deleteAgent,
    },
    locations: {
      getLocations: mocks.getLocations,
      inspectLocationPath: mocks.inspectLocationPath,
      openLocation: mocks.openLocation,
    },
  },
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {
    navigation: {
      currentViewId: 'home',
      revalidate: vi.fn(),
      viewParamsStore: {},
    },
  },
}));

vi.mock('@renderer/lib/stores/view-state-cache', () => ({
  viewStateCache: {
    get: vi.fn(async () => undefined),
  },
}));

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-id',
    locationId: 'location-id',
    name: 'Agent',
    providerId: 'claude',
    switchAgentId: 'sw-1',
    apiEndpoint: 'https://switch.example.com',
    serverId: 'server-1',
    status: null,
    autoApprove: false,
    providerConfig: null,
    createdAt: '2026-05-28T00:00:00.000Z',
    updatedAt: '2026-05-28T00:00:00.000Z',
    ...overrides,
  };
}

describe('LocationManagerStore removeAgent', () => {
  // removeAgent only gets/deletes the location by key, so a placeholder stands in
  // for the (heavy) real LocationStore.
  const stubLocation = {} as LocationStore;

  beforeEach(() => {
    vi.clearAllMocks();
    agentsStore.byLocation.clear();
    mocks.deleteAgent.mockResolvedValue(undefined);
  });

  it('removes only the target agent and keeps the location when siblings remain', async () => {
    const a = agent({ id: 'a', locationId: 'loc' });
    const b = agent({ id: 'b', locationId: 'loc' });
    agentsStore.byLocation.set('loc', [a, b]);
    mocks.getAgents.mockResolvedValue([b]); // source of truth after the delete

    const store = new LocationManagerStore();
    store.locations.set('loc', stubLocation);

    await store.removeAgent('loc', 'a', { deleteInSwitch: false });

    expect(mocks.deleteAgent).toHaveBeenCalledWith({ agentId: 'a', deleteInSwitch: false });
    expect(store.locations.has('loc')).toBe(true);
    expect(agentsStore.byLocation.get('loc')?.map((x) => x.id)).toEqual(['b']);
  });

  it('removes the location when the last agent is deleted', async () => {
    const a = agent({ id: 'a', locationId: 'loc' });
    agentsStore.byLocation.set('loc', [a]);
    mocks.getAgents.mockResolvedValue([]);

    const store = new LocationManagerStore();
    store.locations.set('loc', stubLocation);

    await store.removeAgent('loc', 'a', { deleteInSwitch: true });

    expect(mocks.deleteAgent).toHaveBeenCalledWith({ agentId: 'a', deleteInSwitch: true });
    expect(store.locations.has('loc')).toBe(false);
    expect(agentsStore.byLocation.has('loc')).toBe(false);
  });

  it('restores the agent and location when the delete fails', async () => {
    const a = agent({ id: 'a', locationId: 'loc' });
    agentsStore.byLocation.set('loc', [a]);
    mocks.deleteAgent.mockRejectedValueOnce(new Error('gateway down'));

    const store = new LocationManagerStore();
    store.locations.set('loc', stubLocation);

    await expect(store.removeAgent('loc', 'a', { deleteInSwitch: true })).rejects.toThrow(
      'gateway down'
    );
    expect(store.locations.has('loc')).toBe(true);
    expect(agentsStore.byLocation.get('loc')?.map((x) => x.id)).toEqual(['a']);
  });
});
