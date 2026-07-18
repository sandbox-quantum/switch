import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@shared/core/agents/agents';
import type { Location } from '@shared/core/locations/locations';
import { isUnregisteredLocation } from './location';
import { LocationManagerStore } from './location-manager';

const mocks = vi.hoisted(() => ({
  onboardAgent: vi.fn(),
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
      getAgents: vi.fn(async () => [] as Agent[]),
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
  });
});
