import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What a reset tells the rest of the app about the sessions it removes.
 *
 * A reset deletes rows for sessions that are still, as far as anything watching
 * is concerned, running. It used to announce that only to the renderer, so
 * anything in the main process tracking a session's lifetime never heard the
 * end — including the emitter, which had reported every one of them starting.
 */

const { h } = vi.hoisted(() => ({
  h: {
    sessionRows: [{ id: 's-1' }] as { id: string }[],
    deletedChanges: 1,
    hookEmit: vi.fn(),
    ipcEmit: vi.fn(),
    teardownSession: vi.fn(async () => {}),
  },
}));

vi.mock('drizzle-orm', () => ({ eq: () => ({}) }));
vi.mock('@main/db/schema', () => ({ sessions: { id: 'id', agentId: 'agentId' } }));
vi.mock('@main/db/client', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => Promise.resolve(h.sessionRows) }) }),
    delete: () => ({ where: () => Promise.resolve({ changes: h.deletedChanges }) }),
  },
}));

vi.mock('@main/core/sessions/session-hooks', () => ({
  sessionHooks: { _emit: h.hookEmit },
}));
vi.mock('@main/lib/events', () => ({ events: { emit: h.ipcEmit } }));
vi.mock('@main/core/sessions/session-runtime-manager', () => ({
  sessionRuntimeManager: { teardownSession: h.teardownSession },
}));
vi.mock('@main/core/switch-rooms/switch-room-service', () => ({
  switchRoomService: { clearSession: vi.fn() },
}));
vi.mock('@main/core/view-state/view-state-service', () => ({
  viewStateService: { del: vi.fn(async () => {}) },
}));
vi.mock('@main/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./getAgentById', () => ({
  getAgentById: vi.fn(async () => ({
    id: 'agent-1',
    name: 'codex-hoot',
    providerId: 'codex',
    autoApprove: false,
  })),
}));
vi.mock('./agent-location', () => ({ getRemoteAgentLocation: vi.fn(async () => ({ id: 'loc' })) }));
vi.mock('./agent-launch-config', () => ({ agentLaunchSpecialization: vi.fn(async () => null) }));
vi.mock('./connect-remote-agent', () => ({
  connectRemoteAgent: vi.fn(async () => ({
    host: { exec: vi.fn(async () => {}) },
    remoteRepoDir: '/srv/repo',
    ctx: {},
    connectionId: 'c-1',
    proxy: { forwardOut: vi.fn() },
  })),
}));
vi.mock('./remote-session-reconciler', () => ({ remoteSessionReconciler: { stop: vi.fn() } }));
vi.mock('./remote-watcher', () => ({
  ensureRemoteWatcher: vi.fn(async () => {}),
  startRemoteDiscovery: vi.fn(async () => {}),
}));
vi.mock('@main/core/agent-runtime/impl/remote-sidecar-launcher', () => ({
  writeWatchEnabled: vi.fn(async () => {}),
  agentSidecarTmuxName: (repoDir: string, slug: string) => `switch-sidecar-${slug}`,
}));
// No sidecar to reach, so the reset works from the database rows alone.
vi.mock('@main/core/agent-runtime/impl/ensure-agent-sidecar', () => ({
  probeAgentSidecar: vi.fn(async () => null),
}));
vi.mock('@main/core/agent-runtime/impl/sidecar-http', () => ({ httpGetJsonOverChannel: vi.fn() }));
vi.mock('@main/app/deeplinks', () => ({ DEEPLINK_SCHEME: 'switch' }));

const { resetRemoteAgent } = await import('./reset-remote-agent');

beforeEach(() => {
  vi.clearAllMocks();
  h.sessionRows = [{ id: 's-1' }];
  h.deletedChanges = 1;
});

describe('resetting a remote agent', () => {
  it('announces each removed session on the lifecycle bus, not only to the renderer', async () => {
    await resetRemoteAgent('agent-1');

    expect(h.hookEmit).toHaveBeenCalledWith('session:deleted', 's-1');
    expect(h.ipcEmit).toHaveBeenCalled();
  });

  it('announces every session it removes', async () => {
    h.sessionRows = [{ id: 's-1' }, { id: 's-2' }, { id: 's-3' }];

    await resetRemoteAgent('agent-1');

    expect(h.hookEmit.mock.calls.map(([, id]) => id).sort()).toEqual(['s-1', 's-2', 's-3']);
  });

  it('says nothing for a row that was already gone', async () => {
    // A delete that changed nothing is not a session ending; announcing it
    // would end the same session twice across the two delete paths.
    h.deletedChanges = 0;

    await resetRemoteAgent('agent-1');

    expect(h.hookEmit).not.toHaveBeenCalled();
    expect(h.ipcEmit).not.toHaveBeenCalled();
  });
});
