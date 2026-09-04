import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveSessionAgent = vi.hoisted(() => vi.fn());
const loadSessionWithAgent = vi.hoisted(() => vi.fn());
const mapSessionRowToSession = vi.hoisted(() => vi.fn(() => ({ id: 'session-1' })));
const update = vi.hoisted(() =>
  vi.fn(() => ({ set: () => ({ where: async () => undefined }) }))
);

vi.mock('@main/db/client', () => ({ db: { update } }));
vi.mock('@main/db/schema', () => ({ sessions: { id: 'id' } }));
vi.mock('../../locations/utils', () => ({ resolveSessionAgent }));
vi.mock('../session-join', () => ({ loadSessionWithAgent }));
vi.mock('../utils/utils', () => ({ mapSessionRowToSession }));
vi.mock('@main/core/agent-runtime/attachment/production-remote-attachment-pool', () => ({
  remoteAttachmentPool: { register: vi.fn(), requestAttach: vi.fn(async () => {}) },
}));
vi.mock('@main/core/agent-runtime/attachment/types', () => ({
  isAttachableRuntime: () => false,
}));

const { hydrateSession } = await import('./hydrateSession');

/** A double the real `isProviderRuntime` accepts: it duck-types these two. */
function providerRuntime() {
  return {
    start: vi.fn(async () => {}),
    sendTurn: vi.fn(async () => ({ turnId: 't' })),
    getTranscript: vi.fn(() => ({})),
  };
}

describe('hydrateSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts a provider session that was spawned before this app run', async () => {
    // The adapter's session lives in this process, so a session restored after
    // a restart has none — however much the row remembers being spawned. This
    // returned early, and the restored session sat in "starting" for ever while
    // the room believed the agent was attending it.
    const agent = providerRuntime();
    resolveSessionAgent.mockReturnValue(agent);
    loadSessionWithAgent.mockResolvedValue({
      row: { agentSessionId: 'session-1', config: { initialPrompt: 'connect to switch room r1' } },
      providerId: 'opencode',
      name: 'agent',
    });

    await hydrateSession('session-1');

    expect(agent.start).toHaveBeenCalledTimes(1);
    // Resuming, and without the opening prompt: it was delivered on the first
    // spawn and re-sending it would restart the conversation.
    expect(agent.start).toHaveBeenCalledWith({ id: 'session-1' }, undefined, true, undefined);
  });

  it('gives a first spawn its opening prompt', async () => {
    const agent = providerRuntime();
    resolveSessionAgent.mockReturnValue(agent);
    loadSessionWithAgent.mockResolvedValue({
      row: { agentSessionId: null, config: { initialPrompt: 'connect to switch room r1' } },
      providerId: 'opencode',
      name: 'agent',
    });

    await hydrateSession('session-1');

    expect(agent.start).toHaveBeenCalledWith(
      { id: 'session-1' },
      undefined,
      false,
      'connect to switch room r1'
    );
  });
});
