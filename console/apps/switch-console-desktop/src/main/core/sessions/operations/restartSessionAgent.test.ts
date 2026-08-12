import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveSessionAgent = vi.fn();
const loadSessionWithAgent = vi.fn();
const mapSessionRowToSession = vi.fn(() => ({ id: 'session-1', title: 'A session' }));
const isAttachableRuntime = vi.fn(() => false);
const requestAttach = vi.fn(async () => 'attached');

vi.mock('../../locations/utils', () => ({
  resolveSessionAgent: (id: string) => resolveSessionAgent(id),
}));
vi.mock('../session-join', () => ({
  loadSessionWithAgent: (id: string) => loadSessionWithAgent(id),
}));
vi.mock('../utils/utils', () => ({
  mapSessionRowToSession: (...args: unknown[]) => mapSessionRowToSession(...args),
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

  it('throws when the session row is gone', async () => {
    resolveSessionAgent.mockReturnValue(makeAgent());
    loadSessionWithAgent.mockResolvedValue(null);

    await expect(restartSessionAgent('session-1')).rejects.toThrow(/Session row not found/);
  });
});
