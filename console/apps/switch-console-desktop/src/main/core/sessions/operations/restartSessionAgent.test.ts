import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveSessionAgent = vi.fn();
const loadSessionWithAgent = vi.fn();
const mapSessionRowToSession = vi.fn(
  (_row: unknown, _providerId: unknown, _name: unknown): Record<string, unknown> => ({
    id: 'session-1',
    title: 'A session',
    providerSessionId: 'rollout-abc',
  })
);
const isAttachableRuntime = vi.fn((_runtime: unknown) => false);
const requestAttach = vi.fn(async (_id: string, _reason: string) => 'attached');

vi.mock('../../locations/utils', () => ({
  resolveSessionAgent: (id: string) => resolveSessionAgent(id),
}));
vi.mock('../session-join', () => ({
  loadSessionWithAgent: (id: string) => loadSessionWithAgent(id),
}));
vi.mock('../utils/utils', () => ({
  mapSessionRowToSession: (row: unknown, providerId: unknown, name: unknown) =>
    mapSessionRowToSession(row, providerId, name),
}));
vi.mock('@main/core/agent-runtime/attachment/types', () => ({
  isAttachableRuntime: (runtime: unknown) => isAttachableRuntime(runtime),
}));
vi.mock('@main/core/agent-runtime/attachment/production-remote-attachment-pool', () => ({
  remoteAttachmentPool: {
    requestAttach: (id: string, reason: string) => requestAttach(id, reason),
  },
}));

import { restartSessionAgent } from './restartSessionAgent';

function makeAgent() {
  const calls: string[] = [];
  return {
    calls,
    stop: vi.fn(async () => {
      calls.push('stop');
    }),
    start: vi.fn(async () => {
      calls.push('start');
    }),
  };
}

describe('restartSessionAgent', () => {
  beforeEach(() => {
    resolveSessionAgent.mockReset();
    loadSessionWithAgent.mockReset();
    mapSessionRowToSession.mockClear();
    mapSessionRowToSession.mockReturnValue({
      id: 'session-1',
      title: 'A session',
      providerSessionId: 'rollout-abc',
    });
    isAttachableRuntime.mockReset();
    isAttachableRuntime.mockReturnValue(false);
    requestAttach.mockClear();
    loadSessionWithAgent.mockResolvedValue({ row: {}, providerId: 'codex', name: 'codex.yak' });
  });

  it('stops the agent before starting it again, so the new profile is read at spawn', async () => {
    const agent = makeAgent();
    resolveSessionAgent.mockReturnValue(agent);

    await restartSessionAgent('session-1');

    expect(agent.calls).toEqual(['stop', 'start']);
  });

  it('resumes rather than starting fresh, so the conversation survives the restart', async () => {
    const agent = makeAgent();
    resolveSessionAgent.mockReturnValue(agent);

    await restartSessionAgent('session-1');

    expect(agent.start).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-1' }),
      undefined,
      true
    );
  });

  it('reconciles the attachment pool for a remote runtime, which comes back attached', async () => {
    const agent = makeAgent();
    resolveSessionAgent.mockReturnValue(agent);
    isAttachableRuntime.mockReturnValue(true);

    await restartSessionAgent('session-1');

    expect(requestAttach).toHaveBeenCalledWith('session-1', 'user');
  });

  it('leaves the attachment pool alone for a local runtime, which never registers', async () => {
    const agent = makeAgent();
    resolveSessionAgent.mockReturnValue(agent);

    await restartSessionAgent('session-1');

    expect(requestAttach).not.toHaveBeenCalled();
  });

  it('throws when the session has no running agent to restart', async () => {
    resolveSessionAgent.mockReturnValue(null);

    await expect(restartSessionAgent('session-1')).rejects.toThrow(/no running agent/);
  });

  it('refuses a session that never started a conversation rather than silently starting a new one', async () => {
    const agent = makeAgent();
    resolveSessionAgent.mockReturnValue(agent);
    mapSessionRowToSession.mockReturnValue({ id: 'session-1', title: 'A session' });

    await expect(restartSessionAgent('session-1')).rejects.toThrow(
      /has not started a conversation/
    );
    expect(agent.stop).not.toHaveBeenCalled();
    expect(agent.start).not.toHaveBeenCalled();
  });

  it('throws when the session row is gone', async () => {
    resolveSessionAgent.mockReturnValue(makeAgent());
    loadSessionWithAgent.mockResolvedValue(null);

    await expect(restartSessionAgent('session-1')).rejects.toThrow(/Session row not found/);
  });
});
