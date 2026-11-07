import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRow } from '@main/db/schema';
import { cliConversationForkInFlight } from '../cli-conversation-forks';
import { HostRefusedError } from '../cli-conversations';
import { createSession } from './createSession';

const mocks = vi.hoisted(() => ({
  getAgentById: vi.fn(),
  getLocation: vi.fn(),
  insert: vi.fn(),
  deleteFn: vi.fn(),
  update: vi.fn(),
  set: vi.fn(),
  provisionSessionRuntime: vi.fn(),
  registerSession: vi.fn(),
  startSession: vi.fn(),
  forkCliConversation: vi.fn(),
  discardCliConversationCopies: vi.fn(),
  setProviderSessionId: vi.fn(),
  watcherCheck: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@main/core/sdk-host/watcher-bundle-check', () => ({
  ensureWatcherCanContinueCliConversation: mocks.watcherCheck,
}));

vi.mock('@main/lib/logger', () => ({ log: { error: mocks.logError } }));

vi.mock('./set-provider-session-id', () => ({
  setProviderSessionId: mocks.setProviderSessionId,
}));

vi.mock('../cli-conversations', () => ({
  forkCliConversation: mocks.forkCliConversation,
  discardCliConversationCopies: mocks.discardCliConversationCopies,
  HostRefusedError: class HostRefusedError extends Error {},
}));

vi.mock('@main/core/agents/getAgentById', () => ({
  getAgentById: mocks.getAgentById,
}));

vi.mock('@main/core/locations/location-manager', () => ({
  locationManager: { getLocation: mocks.getLocation },
}));

vi.mock('@main/db/client', () => ({
  db: {
    insert: mocks.insert,
    delete: mocks.deleteFn,
    update: mocks.update,
  },
}));

vi.mock('../session-builder', () => ({
  provisionSessionRuntime: mocks.provisionSessionRuntime,
}));

vi.mock('../session-runtime-manager', () => ({
  sessionRuntimeManager: { registerSession: mocks.registerSession },
}));

function makeSessionRow(values: Partial<SessionRow>): SessionRow {
  return {
    id: values.id ?? 'session-1',
    agentId: values.agentId ?? 'agent-1',
    title: values.title ?? 'Test Session',
    config: values.config ?? null,
    status: values.status ?? 'in_progress',
    agentStatus: values.agentStatus ?? null,
    agentStatusSeen: values.agentStatusSeen ?? 1,
    isInitialSession: values.isInitialSession ?? false,
    isPinned: values.isPinned ?? 0,
    archivedAt: values.archivedAt ?? null,
    lastInteractedAt: values.lastInteractedAt ?? null,
    statusChangedAt: values.statusChangedAt ?? '2026-05-18 12:00:00',
    createdAt: values.createdAt ?? '2026-05-18 12:00:00',
    updatedAt: values.updatedAt ?? '2026-05-18 12:00:00',
  };
}

function setupInsertMock(options: { conflict?: boolean } = {}) {
  mocks.insert.mockReturnValue({
    values: (vals: Partial<SessionRow>) => ({
      onConflictDoNothing: () => ({
        returning: () => Promise.resolve(options.conflict ? [] : [makeSessionRow(vals)]),
      }),
    }),
  });
  mocks.deleteFn.mockReturnValue({ where: () => Promise.resolve() });
  mocks.update.mockReturnValue({ set: mocks.set });
  mocks.set.mockReturnValue({ where: async () => {} });
}

const baseParams = {
  id: 'session-1',
  agentId: 'agent-1',
  title: 'Test Session',
};

describe('createSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAgentById.mockResolvedValue({
      id: 'agent-1',
      locationId: 'loc-1',
      providerId: 'claude',
    });
    mocks.getLocation.mockReturnValue({
      locationId: 'loc-1',
      dir: '/repo',
      ctx: {},
      transport: { kind: 'local' },
    });
    mocks.watcherCheck.mockResolvedValue(undefined);
    mocks.provisionSessionRuntime.mockResolvedValue({
      path: '/repo',
      locationId: 'loc-1',
      agent: { start: mocks.startSession },
    });
    mocks.registerSession.mockResolvedValue(undefined);
    mocks.startSession.mockResolvedValue(undefined);
    setupInsertMock();
  });

  it('returns agent-not-found when the agent does not exist', async () => {
    mocks.getAgentById.mockResolvedValue(undefined);
    const result = await createSession(baseParams);
    expect(result).toEqual({ success: false, error: { type: 'agent-not-found' } });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('continues a copy of a CLI conversation, recording which one it continues', async () => {
    mocks.forkCliConversation.mockResolvedValue('copy-1');
    mocks.setProviderSessionId.mockResolvedValue(true);
    const cliConversation = { nativeSessionId: 'cli-1', title: 'Fix the build' };
    const result = await createSession({
      ...baseParams,
      cliConversation: { ...cliConversation, confirmedClosed: true },
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected session creation to succeed');
    expect(mocks.forkCliConversation).toHaveBeenCalledWith(
      expect.objectContaining({ dir: '/repo' }),
      { id: 'session-1', title: 'Test Session' },
      'cli-1',
      true
    );
    // The row exists before the copy is made, so the copy always has an owner.
    expect(mocks.insert.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.forkCliConversation.mock.invocationCallOrder[0]!
    );
    expect(mocks.setProviderSessionId).toHaveBeenCalledWith('session-1', 'copy-1');
    expect(result.data.session.providerSessionId).toBe('copy-1');
    expect(result.data.session.cliConversation).toEqual(cliConversation);
    expect(mocks.discardCliConversationCopies).not.toHaveBeenCalled();
    expect(mocks.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ providerSessionId: 'copy-1' }),
      false,
      undefined,
      null
    );
  });

  it('does not start a session deleted while its conversation was being copied, and removes the copy', async () => {
    mocks.forkCliConversation.mockResolvedValue('copy-1');
    mocks.setProviderSessionId.mockResolvedValue(false);
    const result = await createSession({
      ...baseParams,
      cliConversation: { nativeSessionId: 'cli-1', title: 'Fix the build', confirmedClosed: false },
    });
    expect(result).toEqual({
      success: false,
      error: {
        type: 'spawn-failed',
        message: 'This session was deleted while its conversation was being copied.',
      },
    });
    expect(mocks.discardCliConversationCopies).toHaveBeenCalledWith(
      expect.objectContaining({ dir: '/repo' }),
      'session-1'
    );
    expect(mocks.provisionSessionRuntime).not.toHaveBeenCalled();
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it('lets anything that starts the session while its copy is made wait for the copy', async () => {
    let made!: (id: string) => void;
    mocks.forkCliConversation.mockReturnValue(
      new Promise<string>((resolve) => {
        made = resolve;
      })
    );
    mocks.setProviderSessionId.mockResolvedValue(true);
    const created = createSession({
      ...baseParams,
      cliConversation: { nativeSessionId: 'cli-1', title: 'Fix the build', confirmedClosed: true },
    });
    await vi.waitFor(() => expect(mocks.forkCliConversation).toHaveBeenCalled());
    const waiting = cliConversationForkInFlight('session-1');
    expect(waiting).toBeDefined();
    made('copy-1');
    // Settled once the row holds the copy, not merely once the copy exists.
    await expect(waiting).resolves.toBe('copy-1');
    expect(mocks.setProviderSessionId).toHaveBeenCalledWith('session-1', 'copy-1');
    await created;
    expect(cliConversationForkInFlight('session-1')).toBeUndefined();
  });

  it('takes the session away again when the host refuses to copy the CLI conversation, with no copy to remove', async () => {
    mocks.forkCliConversation.mockRejectedValue(
      new HostRefusedError(
        'This conversation is open in Claude Code (process 41). Close it there, then try again.'
      )
    );
    const result = await createSession({
      ...baseParams,
      cliConversation: { nativeSessionId: 'cli-1', title: 'Fix the build', confirmedClosed: false },
    });
    expect(result).toEqual({
      success: false,
      error: {
        type: 'spawn-failed',
        message:
          'This conversation is open in Claude Code (process 41). Close it there, then try again.',
      },
    });
    expect(mocks.deleteFn).toHaveBeenCalledTimes(1);
    expect(mocks.discardCliConversationCopies).not.toHaveBeenCalled();
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it('takes the session away again and removes any copy when copying gave no answer', async () => {
    mocks.forkCliConversation.mockRejectedValue(new Error('Timed out after 120000ms'));
    const result = await createSession({
      ...baseParams,
      cliConversation: { nativeSessionId: 'cli-1', title: 'Fix the build', confirmedClosed: true },
    });
    expect(result).toEqual({
      success: false,
      error: { type: 'spawn-failed', message: 'Timed out after 120000ms' },
    });
    expect(mocks.deleteFn).toHaveBeenCalledTimes(1);
    expect(mocks.discardCliConversationCopies).toHaveBeenCalledWith(
      expect.objectContaining({ dir: '/repo' }),
      'session-1'
    );
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it('still says why the copy failed when the session cannot be taken away again', async () => {
    mocks.forkCliConversation.mockRejectedValue(new Error('Timed out after 120000ms'));
    mocks.deleteFn.mockReturnValue({
      where: () => Promise.reject(new Error('SQLITE_BUSY: database is locked')),
    });
    const result = await createSession({
      ...baseParams,
      cliConversation: { nativeSessionId: 'cli-1', title: 'Fix the build', confirmedClosed: true },
    });
    expect(result).toEqual({
      success: false,
      error: { type: 'spawn-failed', message: 'Timed out after 120000ms' },
    });
    expect(mocks.discardCliConversationCopies).toHaveBeenCalledWith(
      expect.objectContaining({ dir: '/repo' }),
      'session-1'
    );
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: 'cli_conversation.session_rollback',
        stage: 'delete-failed',
        sessionId: 'session-1',
        error: 'Error: SQLITE_BUSY: database is locked',
      })
    );
  });

  it('asks an SSH host’s Room watcher whether it can continue a CLI conversation before anything is recorded or copied', async () => {
    const ctx = { exec: vi.fn() };
    mocks.getAgentById.mockResolvedValue({
      id: 'agent-1',
      locationId: 'loc-1',
      providerId: 'claude',
      switchAgentId: 'switch-agent-1',
    });
    mocks.getLocation.mockReturnValue({
      locationId: 'loc-1',
      dir: '/repo',
      ctx,
      transport: { kind: 'ssh', host: 'build-box', dir: '/repo', connectionId: 'conn-1' },
    });
    mocks.watcherCheck.mockRejectedValue(
      new Error("The Room watcher on build-box does not run this version of Switch Console's host")
    );
    const result = await createSession({
      ...baseParams,
      cliConversation: { nativeSessionId: 'cli-1', title: 'Fix the build', confirmedClosed: true },
    });
    expect(result).toEqual({
      success: false,
      error: {
        type: 'spawn-failed',
        message: "The Room watcher on build-box does not run this version of Switch Console's host",
      },
    });
    expect(mocks.watcherCheck).toHaveBeenCalledWith(ctx, 'build-box', 'switch-agent-1');
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.forkCliConversation).not.toHaveBeenCalled();
    expect(mocks.setProviderSessionId).not.toHaveBeenCalled();

    mocks.watcherCheck.mockResolvedValue(undefined);
    mocks.forkCliConversation.mockResolvedValue('copy-1');
    mocks.setProviderSessionId.mockResolvedValue(true);
    const continued = await createSession({
      ...baseParams,
      cliConversation: { nativeSessionId: 'cli-1', title: 'Fix the build', confirmedClosed: true },
    });
    expect(continued.success).toBe(true);
    expect(mocks.watcherCheck.mock.invocationCallOrder.at(-1)).toBeLessThan(
      mocks.insert.mock.invocationCallOrder[0]!
    );
  });

  it('does not ask a Room watcher about a session that continues no CLI conversation', async () => {
    mocks.getLocation.mockReturnValue({
      locationId: 'loc-1',
      dir: '/repo',
      ctx: {},
      transport: { kind: 'ssh', host: 'build-box', dir: '/repo', connectionId: 'conn-1' },
    });
    const result = await createSession(baseParams);
    expect(result.success).toBe(true);
    expect(mocks.watcherCheck).not.toHaveBeenCalled();
  });

  it('refuses to continue a CLI conversation for an agent that is not Claude Code', async () => {
    mocks.getAgentById.mockResolvedValue({
      id: 'agent-1',
      locationId: 'loc-1',
      providerId: 'codex',
    });
    const result = await createSession({
      ...baseParams,
      cliConversation: { nativeSessionId: 'cli-1', title: 'Fix the build', confirmedClosed: false },
    });
    expect(result.success).toBe(false);
    expect(mocks.forkCliConversation).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('inserts the session and provisions the runtime', async () => {
    const result = await createSession(baseParams);
    expect(result.success).toBe(true);
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.provisionSessionRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.registerSession).toHaveBeenCalledTimes(1);
    expect(mocks.startSession).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('does not persist a stale bypass override (%s)', async (stale) => {
    const result = await createSession({ ...baseParams, ...{ autoApprove: stale } });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected session creation to succeed');
    expect(result.data.session.autoApprove).toBeUndefined();
    expect(mocks.startSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ autoApprove: stale }),
      false,
      undefined,
      null
    );
  });

  it.each([
    ['user', 'user'],
    ['auto', 'automation'],
    ['unknown', null],
    [undefined, null],
  ] as const)(
    'tells the host a session started by %s was started by %s',
    async (startSource, reported) => {
      const result = await createSession({ ...baseParams, startSource });
      expect(result.success).toBe(true);
      expect(mocks.startSession.mock.calls[0]![3]).toBe(reported);
    }
  );

  it('adopts a session at a closed location without provisioning or launching it', async () => {
    mocks.getLocation.mockReturnValue(undefined);
    const result = await createSession({ ...baseParams, startSource: 'adopted', attach: false });
    expect(result.success).toBe(true);
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.getLocation).not.toHaveBeenCalled();
    expect(mocks.provisionSessionRuntime).not.toHaveBeenCalled();
    expect(mocks.registerSession).not.toHaveBeenCalled();
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it('preserves the session row after a failed launch so recovery cannot create another conversation', async () => {
    mocks.provisionSessionRuntime.mockRejectedValue(new Error('boom'));
    const result = await createSession(baseParams);
    expect(result).toEqual({ success: false, error: { type: 'spawn-failed', message: 'boom' } });
    expect(mocks.deleteFn).not.toHaveBeenCalled();
    expect(mocks.set).toHaveBeenCalledWith({ status: 'review' });
  });

  it('returns already-exists when the id is taken, without provisioning or rollback', async () => {
    setupInsertMock({ conflict: true });
    const result = await createSession(baseParams);
    expect(result).toEqual({ success: false, error: { type: 'already-exists' } });
    expect(mocks.provisionSessionRuntime).not.toHaveBeenCalled();
    expect(mocks.deleteFn).not.toHaveBeenCalled();
  });
});
