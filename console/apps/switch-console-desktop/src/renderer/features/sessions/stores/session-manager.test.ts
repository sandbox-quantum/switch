import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@shared/core/sessions/sessions';
import { SessionManagerStore } from './session-manager';
import { createUnprovisionedSession, createUnregisteredSession } from './session-store';

type MockViewModel = {
  initialize: ReturnType<typeof vi.fn>;
  suspend: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  restoreSnapshot: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => ({
  archiveSession: vi.fn(),
  agentAcquire: vi.fn(),
  agentRelease: vi.fn(),
  getLocationManagerStore: vi.fn(),
  getSessionGitWorktreeStore: vi.fn(),
  getSessions: vi.fn(),
  mountLocation: vi.fn(),
  provisionSession: vi.fn(),
  teardownSession: vi.fn(),
  viewModels: [] as MockViewModel[],
  viewStateGet: vi.fn(),
  runtimeActivate: vi.fn(),
  runtimeAcquire: vi.fn(),
  runtimeRelease: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: {
    on: vi.fn(() => () => {}),
  },
  rpc: {
    agents: {
      getAgentById: vi.fn(),
    },
    sessions: {
      archiveSession: mocks.archiveSession,
      getSessions: mocks.getSessions,
      provisionSession: mocks.provisionSession,
      teardownSession: mocks.teardownSession,
    },
  },
}));

vi.mock('@renderer/features/locations/stores/location-selectors', () => ({
  getLocationManagerStore: mocks.getLocationManagerStore,
}));

vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({
  getSessionGitWorktreeStore: mocks.getSessionGitWorktreeStore,
}));

vi.mock('@renderer/lib/stores/view-state-cache', () => ({
  viewStateCache: {
    get: mocks.viewStateGet,
  },
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}));

vi.mock('./session-view-model', () => ({
  SessionViewModel: class {
    initialize = vi.fn();
    suspend = vi.fn();
    dispose = vi.fn();
    restoreSnapshot = vi.fn();

    constructor() {
      mocks.viewModels.push(this);
    }
  },
}));

vi.mock('./session-runtime-registry', () => ({
  sessionRuntimeRegistry: {
    activate: mocks.runtimeActivate,
    acquire: mocks.runtimeAcquire,
    release: mocks.runtimeRelease,
  },
}));

vi.mock('./session-agent-registry', () => ({
  sessionAgentRegistry: {
    acquire: mocks.agentAcquire,
    get: vi.fn(),
    release: mocks.agentRelease,
  },
}));

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    agentId: 'agent-1',
    providerId: 'claude',
    title: 'Session 1',
    shellId: 'system',
    status: 'todo',
    agentSessionId: null,
    isInitialSession: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    statusChangedAt: '2026-01-01T00:00:00.000Z',
    isPinned: false,
    ...overrides,
  };
}

function makeSessionManager(): SessionManagerStore {
  return new SessionManagerStore('location-1', { pageData: { invalidate: vi.fn() } } as never);
}

describe('SessionManagerStore archive lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.viewModels.length = 0;
    mocks.archiveSession.mockResolvedValue(undefined);
    mocks.getLocationManagerStore.mockReturnValue({ mountLocation: mocks.mountLocation });
    mocks.getSessions.mockResolvedValue([]);
    mocks.mountLocation.mockResolvedValue(undefined);
    mocks.provisionSession.mockResolvedValue({
      success: true,
      data: {
        path: '/tmp/location-1',
        locationId: 'location-1',
      },
    });
    mocks.viewStateGet.mockResolvedValue(undefined);
  });

  it('archives by disposing frontend runtime instead of soft-tearing down the session', async () => {
    const manager = makeSessionManager();
    const session = makeSession();
    const store = createUnprovisionedSession('location-1', session);
    store.transitionToProvisioned(session, '/tmp/loc-1');
    const viewModel = mocks.viewModels[0];
    manager.sessions.set(session.id, store);

    await manager.archiveSession(session.id);

    expect(mocks.archiveSession).toHaveBeenCalledWith('session-1');
    expect(mocks.teardownSession).not.toHaveBeenCalled();
    expect(mocks.agentRelease).toHaveBeenCalledWith('session-1');
    expect(viewModel.dispose).toHaveBeenCalledOnce();
    expect(store.state).toBe('unprovisioned');
    expect(store.phase).toBe('idle');
    expect(store.viewModel).toBeNull();
    expect((store.data as Session).archivedAt).toBeDefined();

    manager.dispose();
  });

  it('reacquires frontend managers before provisioning a dry restored session', async () => {
    const manager = makeSessionManager();
    const session = makeSession({ archivedAt: undefined });
    const store = createUnprovisionedSession('location-1', session);
    store.transitionToDryUnprovisioned(session);
    manager.sessions.set(session.id, store);

    await manager.provisionSession(session.id);

    expect(mocks.agentAcquire).toHaveBeenCalledWith('session-1', 'location-1');
    expect(store.state).toBe('provisioned');
    expect(store.viewModel).toBe(mocks.viewModels[1]);
    expect(mocks.viewModels[1].initialize).toHaveBeenCalledOnce();

    manager.dispose();
  });
});

describe('SessionManagerStore discardFailedCreations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.viewModels.length = 0;
    mocks.getLocationManagerStore.mockReturnValue({ mountLocation: mocks.mountLocation });
    mocks.getSessions.mockResolvedValue([]);
    mocks.mountLocation.mockResolvedValue(undefined);
  });

  function makeFailedCreation(manager: SessionManagerStore, id: string) {
    const store = createUnregisteredSession('location-1', {
      id,
      title: 'Failed session',
      status: 'in_progress',
      lastInteractedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      statusChangedAt: '2026-01-01T00:00:00.000Z',
      isPinned: false,
    });
    store.phase = 'create-error';
    store.errorMessage = 'remote host cannot reach the Switch endpoint';
    manager.sessions.set(id, store);
    return store;
  }

  // The server rejected the create, so there is nothing there to delete. The
  // mocked rpc.sessions has no deleteSessions at all — reaching for the server
  // would throw, so this passing is what proves the discard stays local.
  it('drops a session whose creation failed, without going to the server', () => {
    const manager = makeSessionManager();
    makeFailedCreation(manager, 'session-failed');

    manager.discardFailedCreations();

    expect(manager.sessions.has('session-failed')).toBe(false);
    expect(mocks.agentRelease).toHaveBeenCalledWith('session-failed');

    manager.dispose();
  });

  // A provision error belongs to a session the server did register, so it is
  // listed in the sidebar and its own view offers a retry. Discarding it would
  // hide a session that still exists.
  it('leaves a provision error alone', () => {
    const manager = makeSessionManager();
    const session = makeSession({ id: 'session-provisioned' });
    const store = createUnprovisionedSession('location-1', session);
    store.phase = 'provision-error';
    manager.sessions.set(session.id, store);

    manager.discardFailedCreations();

    expect(manager.sessions.has('session-provisioned')).toBe(true);
    expect(mocks.agentRelease).not.toHaveBeenCalled();

    manager.dispose();
  });

  it('is a no-op when nothing failed to be created', () => {
    const manager = makeSessionManager();
    const session = makeSession({ id: 'session-healthy' });
    manager.sessions.set(session.id, createUnprovisionedSession('location-1', session));

    manager.discardFailedCreations();

    expect(manager.sessions.has('session-healthy')).toBe(true);
    expect(mocks.agentRelease).not.toHaveBeenCalled();

    manager.dispose();
  });
});
