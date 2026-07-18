import { afterEach, describe, expect, it, vi } from 'vitest';

const REMOTE_AGENT = {
  id: 'agent-1',
  connection: 'remote',
  remoteConfig: { sshHost: 'vm', remoteRepoDir: '/home/dev/repo' },
  providerId: 'claude',
  projectId: 'proj-1',
  switchAgentId: 'switch-1',
};

const getAgentById = vi.fn(async () => REMOTE_AGENT as unknown);
const createSession = vi.fn(async (_p: unknown) => ({
  success: true,
  data: { session: { id: 'x' } },
}));
const provisionWorkspace = vi.fn(async (_id: string) => ({ success: true }));
const probeAgentSidecar = vi.fn(
  async () => ({ port: 4321, token: 'tok' }) as { port: number; token: string } | null
);
const httpGetJsonOverChannel = vi.fn();
let knownRows: Array<{ id: string; agentId?: string }> = [];
const deleteWhere = vi.fn(async (_arg?: unknown) => ({ changes: 1 }));

vi.mock('./getAgentById', () => ({ getAgentById: () => getAgentById() }));
vi.mock('./connect-remote-agent', () => ({
  connectRemoteAgent: async () => ({
    proxy: { forwardOut: async () => ({ destroy: vi.fn() }) },
    ctx: {},
    connectionId: 'conn-1',
    remoteRepoDir: '/home/dev/repo',
    host: {},
  }),
}));
vi.mock('@main/core/agent-runtime/impl/ensure-agent-sidecar', () => ({
  probeAgentSidecar: () => probeAgentSidecar(),
}));
vi.mock('@main/core/agent-runtime/impl/sidecar-http', () => ({
  httpGetJsonOverChannel: () => httpGetJsonOverChannel(),
}));
vi.mock('@main/core/sessions/session-service', () => ({
  sessionService: {
    createSession: (p: unknown) => createSession(p as never),
    provisionWorkspace: (id: string) => provisionWorkspace(id as never),
  },
}));
vi.mock('@main/app/deeplinks', () => ({ DEEPLINK_SCHEME: 'switchdash' }));
vi.mock('@main/db/schema', () => ({ sessions: { id: 'id', agentId: 'agentId' } }));
vi.mock('@main/db/client', () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => knownRows }) }),
    delete: () => ({ where: (arg: unknown) => deleteWhere(arg as never) }),
  },
}));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const eventsEmit = vi.fn();
vi.mock('@main/lib/events', () => ({
  events: { emit: (...args: unknown[]) => eventsEmit(...args) },
}));

import { sessionHooks } from '@main/core/sessions/session-hooks';
import { sessionDeletedChannel } from '@shared/core/sessions/sessionEvents';
import { remoteSessionReconciler } from './remote-session-reconciler';

// Reach the private reconcile pass without the periodic timer.
function reconcile(agentId: string): Promise<void> {
  return (
    remoteSessionReconciler as unknown as { reconcileOnce: (id: string) => Promise<void> }
  ).reconcileOnce(agentId);
}

function handleRemoteTerminated(sessionId: string): Promise<void> {
  return (
    remoteSessionReconciler as unknown as {
      handleRemoteTerminated: (id: string) => Promise<void>;
    }
  ).handleRemoteTerminated(sessionId);
}

describe('RemoteSessionReconciler', () => {
  afterEach(() => {
    vi.clearAllMocks();
    knownRows = [];
    remoteSessionReconciler.dispose();
  });

  it('adopts a VM session switchdash has never seen, keyed by the VM conversation id', async () => {
    knownRows = [];
    httpGetJsonOverChannel.mockResolvedValue({
      sessions: [{ sessionId: 'conv-new', roomId: 'room-1' }],
    });
    await reconcile('agent-1');

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conv-new', agentId: 'agent-1', autoApprove: true })
    );
    expect(provisionWorkspace).toHaveBeenCalledWith('conv-new');
  });

  it('skips a VM session that already has a switchdash row', async () => {
    knownRows = [{ id: 'conv-known' }];
    httpGetJsonOverChannel.mockResolvedValue({
      sessions: [{ sessionId: 'conv-known', roomId: 'room-1' }],
    });
    await reconcile('agent-1');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('does nothing when the sidecar reports no sessions', async () => {
    httpGetJsonOverChannel.mockResolvedValue({ sessions: [] });
    await reconcile('agent-1');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('does not poll or adopt when no sidecar is running (probe returns null)', async () => {
    probeAgentSidecar.mockResolvedValueOnce(null);
    await reconcile('agent-1');
    expect(httpGetJsonOverChannel).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it('refuses to re-adopt a tombstoned (just-deleted) conversation id', async () => {
    knownRows = [];
    httpGetJsonOverChannel.mockResolvedValue({
      sessions: [{ sessionId: 'conv-deleted', roomId: 'room-1' }],
    });
    remoteSessionReconciler.tombstone('conv-deleted');
    await reconcile('agent-1');

    expect(createSession).not.toHaveBeenCalled();
  });

  it('removes a remotely-terminated session row, emits deletion, and refuses re-adoption', async () => {
    const emitSpy = vi.spyOn(sessionHooks, '_emit');
    await handleRemoteTerminated('conv-term');

    expect(deleteWhere).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith('session:deleted', 'conv-term');

    // The tombstone set during teardown must block re-adoption from a stale snapshot.
    knownRows = [];
    httpGetJsonOverChannel.mockResolvedValue({
      sessions: [{ sessionId: 'conv-term', roomId: 'room-1' }],
    });
    await reconcile('agent-1');
    expect(createSession).not.toHaveBeenCalled();

    emitSpy.mockRestore();
  });

  it('notifies the renderer (session:deleted) with the resolved projectId when a row is removed', async () => {
    // The removal originates in the main process, so the renderer needs an IPC
    // event to drop the sidebar row (a user-initiated delete removes it itself).
    knownRows = [{ id: 'conv-term', agentId: 'agent-1' }];
    await handleRemoteTerminated('conv-term');

    expect(eventsEmit).toHaveBeenCalledWith(sessionDeletedChannel, {
      sessionId: 'conv-term',
      projectId: 'proj-1',
    });
  });

  it('does not emit session:deleted when the row was already gone (no-op delete)', async () => {
    // Every relay/instance delivers the same session-terminated; only the first
    // delete removes a row, the rest are no-ops and must stay silent.
    deleteWhere.mockResolvedValueOnce({ changes: 0 });
    const emitSpy = vi.spyOn(sessionHooks, '_emit');
    await handleRemoteTerminated('conv-already-gone');

    expect(deleteWhere).toHaveBeenCalledTimes(1);
    expect(emitSpy).not.toHaveBeenCalledWith('session:deleted', 'conv-already-gone');
    emitSpy.mockRestore();
  });

  it('prunes an adopted session only after it stays absent for the threshold', async () => {
    const emitSpy = vi.spyOn(sessionHooks, '_emit');
    knownRows = [];
    httpGetJsonOverChannel.mockResolvedValue({
      sessions: [{ sessionId: 'conv-a', roomId: 'room-1' }],
    });
    await reconcile('agent-1'); // adopt conv-a
    expect(createSession).toHaveBeenCalledTimes(1);

    // Row now exists (so it is not re-adopted); VM stops reporting it.
    knownRows = [{ id: 'conv-a' }];
    httpGetJsonOverChannel.mockResolvedValue({ sessions: [] });
    await reconcile('agent-1'); // streak 1
    await reconcile('agent-1'); // streak 2
    expect(deleteWhere).not.toHaveBeenCalled();
    await reconcile('agent-1'); // streak 3 → prune
    expect(deleteWhere).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith('session:deleted', 'conv-a');
    emitSpy.mockRestore();
  });

  it('does not prune an adopted session that keeps being reported', async () => {
    knownRows = [];
    httpGetJsonOverChannel.mockResolvedValue({
      sessions: [{ sessionId: 'conv-a', roomId: 'room-1' }],
    });
    await reconcile('agent-1'); // adopt
    knownRows = [{ id: 'conv-a' }];
    // Absent once, then present again — streak must reset, no prune.
    httpGetJsonOverChannel.mockResolvedValueOnce({ sessions: [] });
    await reconcile('agent-1');
    httpGetJsonOverChannel.mockResolvedValue({
      sessions: [{ sessionId: 'conv-a', roomId: 'room-1' }],
    });
    await reconcile('agent-1');
    await reconcile('agent-1');
    await reconcile('agent-1');
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it('adopts other VM sessions in the same pass as a tombstoned one', async () => {
    knownRows = [];
    httpGetJsonOverChannel.mockResolvedValue({
      sessions: [
        { sessionId: 'conv-deleted', roomId: 'room-1' },
        { sessionId: 'conv-new', roomId: 'room-2' },
      ],
    });
    remoteSessionReconciler.tombstone('conv-deleted');
    await reconcile('agent-1');

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'conv-new' }));
  });

  it('skips a VM session whose row belongs to another agent (global id check)', async () => {
    // The sessions PK is the conversation id; a row minted under a different
    // agent must block adoption or the insert would crash with UNIQUE failed.
    knownRows = [{ id: 'conv-shared', agentId: 'agent-OTHER' }];
    httpGetJsonOverChannel.mockResolvedValue({
      sessions: [{ sessionId: 'conv-shared', roomId: 'room-1' }],
    });
    await reconcile('agent-1');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('treats an adoption race (already-exists) as a skip, not a failure', async () => {
    knownRows = [];
    createSession.mockResolvedValueOnce({
      success: false,
      error: { type: 'already-exists' },
    } as never);
    httpGetJsonOverChannel.mockResolvedValue({
      sessions: [{ sessionId: 'conv-race', roomId: 'room-1' }],
    });
    await reconcile('agent-1');

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(provisionWorkspace).not.toHaveBeenCalled();
  });

  it('stops a duplicate reconciler whose agent shares an already-claimed sidecar', async () => {
    // agent-1 and agent-2 share host+repoDir → one sidecar, one snapshot.
    // Whoever reconciles it first holds the claim; the other stops itself.
    httpGetJsonOverChannel.mockResolvedValue({ sessions: [] });
    remoteSessionReconciler.start('agent-1');
    await vi.waitFor(() => expect(httpGetJsonOverChannel).toHaveBeenCalled());

    getAgentById.mockResolvedValueOnce({ ...REMOTE_AGENT, id: 'agent-2' } as unknown as never);
    const callsBefore = httpGetJsonOverChannel.mock.calls.length;
    await reconcile('agent-2');

    // agent-2's pass bailed before polling the sidecar.
    expect(httpGetJsonOverChannel.mock.calls.length).toBe(callsBefore);
  });
});
