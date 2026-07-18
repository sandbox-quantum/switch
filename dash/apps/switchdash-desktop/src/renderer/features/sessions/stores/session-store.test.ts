import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@shared/core/sessions/sessions';
import { createUnprovisionedSession } from './session-store';

type MockViewModel = {
  initialize: ReturnType<typeof vi.fn>;
  suspend: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  restoreSnapshot: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => ({
  viewModels: [] as MockViewModel[],
  workspaceAcquire: vi.fn(),
  workspaceRelease: vi.fn(),
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
    acquire: mocks.workspaceAcquire,
    release: mocks.workspaceRelease,
  },
}));

vi.mock('./conversation-registry', () => ({
  conversationRegistry: {
    get: vi.fn(),
  },
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: {
    on: vi.fn(() => () => {}),
  },
  rpc: {
    sessions: {
      renameSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      setSessionPinned: vi.fn(),
    },
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

describe('SessionStore frontend runtime lifecycle', () => {
  beforeEach(() => {
    mocks.viewModels.length = 0;
    mocks.workspaceAcquire.mockReset();
    mocks.workspaceRelease.mockReset();
  });

  it('can transition a provisioned session back to a dry unprovisioned state', () => {
    const session = makeSession();
    const store = createUnprovisionedSession('location-1', session);

    store.transitionToProvisioned(session, '/tmp/loc-1');
    const viewModel = mocks.viewModels[0];

    store.transitionToDryUnprovisioned({ ...session, archivedAt: '2026-01-02T00:00:00.000Z' });

    expect(viewModel.dispose).toHaveBeenCalledOnce();
    expect(mocks.workspaceRelease).toHaveBeenCalledWith('location-1');
    expect(store.state).toBe('unprovisioned');
    expect(store.phase).toBe('idle');
    expect(store.viewModel).toBeNull();
    expect((store.data as Session).archivedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('recreates registered stores before reprovisioning a dry session', () => {
    const session = makeSession();
    const store = createUnprovisionedSession('location-1', session);
    const firstViewModel = mocks.viewModels[0];

    store.transitionToDryUnprovisioned(session);
    expect(store.viewModel).toBeNull();

    store.transitionToProvisioned(session, '/tmp/loc-1');

    expect(mocks.viewModels).toHaveLength(2);
    expect(store.viewModel).toBe(mocks.viewModels[1]);
    expect(store.viewModel).not.toBe(firstViewModel);
    expect(mocks.viewModels[1].initialize).toHaveBeenCalledOnce();
    expect(store.state).toBe('provisioned');
  });
});
