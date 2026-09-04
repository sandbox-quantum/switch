import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@shared/core/agents/agents';
import type { Location } from '@shared/core/locations/locations';
import { agentsStore } from './agents-store';
import { isUnregisteredLocation, type LocationStore } from './location';
import { LocationManagerStore } from './location-manager';

const mocks = vi.hoisted(() => ({
  onboardAgent: vi.fn(),
  getAgents: vi.fn(async () => [] as Agent[]),
  deleteAgent: vi.fn(async () => {}),
  getLocations: vi.fn(async () => [] as Location[]),
  inspectLocationPath: vi.fn(),
  openLocation: vi.fn(),
  eventOn: vi.fn(),
  refreshAfterOnboarding: vi.fn(async () => {}),
}));

vi.mock('@renderer/features/sidebar/sidebar-tree-data', () => ({
  refreshSidebarRoomStateAfterOnboarding: mocks.refreshAfterOnboarding,
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

function location(overrides: Partial<Location> = {}): Location {
  return {
    id: 'location-id',
    name: 'Location',
    sshHost: null,
    dir: '/location',
    createdAt: '2026-05-28T00:00:00.000Z',
    updatedAt: '2026-05-28T00:00:00.000Z',
    ...overrides,
  };
}

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

describe('LocationManagerStore agent onboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inspectLocationPath.mockResolvedValue({ isDirectory: true });
    mocks.onboardAgent.mockResolvedValue({ success: true, data: agent() });
    mocks.getLocations.mockResolvedValue([location()]);
    mocks.openLocation.mockReturnValue(new Promise(() => {}));
  });

  it('returns an existing location without starting onboarding', async () => {
    mocks.inspectLocationPath.mockResolvedValueOnce({
      isDirectory: true,
      existingLocation: location({ id: 'existing-location' }),
    });
    const store = new LocationManagerStore();

    const result = await store.startAgentOnboarding(
      {
        mode: 'pick',
        name: 'Location',
        path: '/location',
        serverId: 'server-1',
        providerId: 'claude',
      },
      { id: 'optimistic-location' }
    );

    expect(result).toEqual({ kind: 'existing', locationId: 'existing-location' });
    expect(mocks.onboardAgent).not.toHaveBeenCalled();
    expect(store.locations.has('optimistic-location')).toBe(false);
    expect(store.pendingCreationIds.has('optimistic-location')).toBe(false);
  });

  it('creates unregistered location state before returning creating', async () => {
    let resolveOnboard: (a: Agent) => void = () => {};
    mocks.onboardAgent.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOnboard = (a) => resolve({ success: true, data: a });
      })
    );
    const store = new LocationManagerStore();

    const result = await store.startAgentOnboarding(
      {
        mode: 'pick',
        name: 'Location',
        path: '/location',
        serverId: 'server-1',
        providerId: 'claude',
      },
      { id: 'optimistic-location' }
    );

    expect(result.kind).toBe('creating');
    const pending = store.locations.get('optimistic-location');
    expect(pending && isUnregisteredLocation(pending)).toBe(true);
    expect(pending?.phase).toBe('registering');
    expect(store.pendingCreationIds.has('optimistic-location')).toBe(true);
    expect(mocks.inspectLocationPath).toHaveBeenCalledTimes(1);

    resolveOnboard(agent());
    if (result.kind === 'creating') await result.completion;

    expect(store.pendingCreationIds.has('optimistic-location')).toBe(false);
  });

  it('marks onboarding as failed when the RPC returns a typed error', async () => {
    mocks.onboardAgent.mockResolvedValueOnce({
      success: false,
      error: {
        type: 'switch-server-unauthenticated',
        dir: '/location',
        serverId: 'server-1',
        serverName: 'Pilot',
      },
    });
    const store = new LocationManagerStore();

    const result = await store.startAgentOnboarding(
      {
        mode: 'pick',
        name: 'Location',
        path: '/location',
        serverId: 'server-1',
        providerId: 'claude',
      },
      { id: 'optimistic-location' }
    );

    expect(result.kind).toBe('creating');
    if (result.kind === 'creating') {
      await expect(result.completion).resolves.toMatchObject({ success: false });
    }

    const loc = store.locations.get('optimistic-location');
    expect(loc && isUnregisteredLocation(loc)).toBe(true);
    if (loc && isUnregisteredLocation(loc)) {
      expect(loc.phase).toBe('error');
      expect(loc.error).toBe('Sign in to Pilot before adding this agent.');
    }

    expect(mocks.refreshAfterOnboarding).not.toHaveBeenCalled();
  });

  it('refreshes sidebar room state once the agent is onboarded', async () => {
    const store = new LocationManagerStore();

    const result = await store.startAgentOnboarding(
      {
        mode: 'pick',
        name: 'Location',
        path: '/location',
        serverId: 'server-1',
        providerId: 'claude',
      },
      { id: 'optimistic-location' }
    );

    expect(result.kind).toBe('creating');
    if (result.kind === 'creating') await result.completion;

    // The agent's rooms are written server-side after onboarding returns, so
    // nothing would show them until the background reconcile without this.
    expect(mocks.refreshAfterOnboarding).toHaveBeenCalledTimes(1);
  });
});

describe('LocationManagerStore reload', () => {
  const stubLocation = {} as LocationStore;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.openLocation.mockResolvedValue({ success: true });
  });

  it('mounts a newly-appeared location on reload', async () => {
    const store = new LocationManagerStore();
    // First load: no locations, no agents.
    mocks.getLocations.mockResolvedValueOnce([]);
    mocks.getAgents.mockResolvedValueOnce([]);
    await store.load();
    expect(store.locations.size).toBe(0);

    // An agent was loaded externally — reload should pick it up.
    mocks.getLocations.mockResolvedValueOnce([location({ id: 'new-loc' })]);
    mocks.getAgents.mockResolvedValueOnce([agent({ locationId: 'new-loc' })]);
    await store.reload();
    expect(store.locations.has('new-loc')).toBe(true);
  });

  it('drops a location whose last agent was removed on reload', async () => {
    const store = new LocationManagerStore();
    store.locations.set('stale-loc', stubLocation);

    // The DB still has the location row but no agents point at it.
    mocks.getLocations.mockResolvedValueOnce([location({ id: 'stale-loc' })]);
    mocks.getAgents.mockResolvedValueOnce([]);
    await store.reload();
    expect(store.locations.has('stale-loc')).toBe(false);
  });
});

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

    await store.removeAgent('loc', 'a', { deleteInSwitch: false, removeProvisionedFiles: false });

    expect(mocks.deleteAgent).toHaveBeenCalledWith({
      agentId: 'a',
      deleteInSwitch: false,
      removeProvisionedFiles: false,
      trigger: 'user',
    });
    expect(store.locations.has('loc')).toBe(true);
    expect(agentsStore.byLocation.get('loc')?.map((x) => x.id)).toEqual(['b']);
  });

  it('removes the location when the last agent is deleted', async () => {
    const a = agent({ id: 'a', locationId: 'loc' });
    agentsStore.byLocation.set('loc', [a]);
    mocks.getAgents.mockResolvedValue([]);

    const store = new LocationManagerStore();
    store.locations.set('loc', stubLocation);

    await store.removeAgent('loc', 'a', { deleteInSwitch: true, removeProvisionedFiles: false });

    expect(mocks.deleteAgent).toHaveBeenCalledWith({
      agentId: 'a',
      deleteInSwitch: true,
      removeProvisionedFiles: false,
      trigger: 'user',
    });
    expect(store.locations.has('loc')).toBe(false);
    expect(agentsStore.byLocation.has('loc')).toBe(false);
  });

  it('restores the agent and location when the delete fails', async () => {
    const a = agent({ id: 'a', locationId: 'loc' });
    agentsStore.byLocation.set('loc', [a]);
    mocks.deleteAgent.mockRejectedValueOnce(new Error('gateway down'));

    const store = new LocationManagerStore();
    store.locations.set('loc', stubLocation);

    await expect(
      store.removeAgent('loc', 'a', { deleteInSwitch: true, removeProvisionedFiles: false })
    ).rejects.toThrow('gateway down');
    expect(store.locations.has('loc')).toBe(true);
    expect(agentsStore.byLocation.get('loc')?.map((x) => x.id)).toEqual(['a']);
  });
});
