import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentAvatarUrlForName } from '@shared/core/agents/agent-avatar';
import type { RemoteAgentSummary, SwitchServer } from '@shared/core/switch-servers/switch-servers';

const fetchAgents = vi.fn();
const updateAgentIcon = vi.fn();
const getAgents = vi.fn();

/** Stands in for the real `GatewayError`, which the module narrows on by
 * `instanceof` and by `status`. */
class FakeGatewayError extends Error {
  constructor(
    readonly kind: string,
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}

vi.mock('./gateway-client', () => ({
  fetchAgents: (...args: unknown[]) => fetchAgents(...args),
  updateAgentIcon: (...args: unknown[]) => updateAgentIcon(...args),
  GatewayError: FakeGatewayError,
}));

vi.mock('@main/core/agents/getAgents', () => ({
  getAgents: (...args: unknown[]) => getAgents(...args),
}));

vi.mock('@main/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

function agent(overrides: Partial<RemoteAgentSummary>): RemoteAgentSummary {
  return {
    id: 'a-1',
    name: 'worker',
    description: '',
    connectorType: 'claude-code',
    ownerId: 'user-me',
    ownerName: 'me',
    knownAgentType: 'claude-code',
    addressingPolicy: null,
    iconUrl: null,
    displayName: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function server(id: string): SwitchServer {
  return { id } as SwitchServer;
}

/**
 * Set up a server's agent list and which of them this install manages locally.
 * `managed` defaults to all of them — the ordinary case of a machine looking at
 * its own agents.
 */
function given(remote: RemoteAgentSummary[], managed?: string[]) {
  const ids = managed ?? remote.map((a) => a.id);
  fetchAgents.mockResolvedValue(remote);
  getAgents.mockResolvedValue(
    ids.map((switchAgentId) => ({ id: `local-${switchAgentId}`, switchAgentId, serverId: 's-1' }))
  );
}

/** Re-imported per test: the module remembers which servers it has done, which
 * is the behaviour under test in one case and interference in every other. */
async function loadFresh() {
  vi.resetModules();
  return (await import('./backfill-agent-icons')).backfillAgentIcons;
}

beforeEach(() => {
  fetchAgents.mockReset().mockResolvedValue([]);
  getAgents.mockReset().mockResolvedValue([]);
  updateAgentIcon.mockReset().mockResolvedValue(agent({}));
});

describe('backfillAgentIcons', () => {
  it('gives an icon-less agent the avatar its name generates', async () => {
    given([agent({ id: 'a-1', name: 'switch_worker' })]);
    const backfill = await loadFresh();

    expect(await backfill(server('s-1'))).toEqual({ kind: 'written', written: 1 });
    expect(updateAgentIcon).toHaveBeenCalledWith(
      expect.anything(),
      'a-1',
      agentAvatarUrlForName('switch_worker')
    );
  });

  it('gives an agent with no recorded owner its icon', async () => {
    // The regression that made this whole pass a no-op: agents registered
    // before Switch tracked ownership have `ownerId: null`, and filtering on
    // "owned by me" skipped precisely the oldest agents — the ones a backfill
    // exists for. Whether the write is allowed is the gateway's call.
    given([agent({ id: 'a-1', name: 'ancient', ownerId: null })]);
    const backfill = await loadFresh();

    expect(await backfill(server('s-1'))).toEqual({ kind: 'written', written: 1 });
    expect(updateAgentIcon).toHaveBeenCalledOnce();
  });

  it('leaves an agent that already has an icon alone', async () => {
    // A chosen icon is the owner's; overwriting it with a generated one would
    // undo their choice on every startup.
    given([agent({ iconUrl: 'https://example.com/mine.png' })]);
    const backfill = await loadFresh();

    expect(await backfill(server('s-1'))).toEqual({ kind: 'written', written: 0 });
    expect(updateAgentIcon).not.toHaveBeenCalled();
  });

  it('ignores an agent this install does not manage', async () => {
    // `GET /agents` lists the whole server. Someone else's agent is not ours to
    // give a picture to, even if this user happens to be an admin.
    given([agent({ id: 'a-1' }), agent({ id: 'someone-elses' })], ['a-1']);
    const backfill = await loadFresh();

    expect(await backfill(server('s-1'))).toEqual({ kind: 'written', written: 1 });
    expect(updateAgentIcon).toHaveBeenCalledWith(expect.anything(), 'a-1', expect.any(String));
  });

  it('ignores a local agent belonging to a different server', async () => {
    fetchAgents.mockResolvedValue([agent({ id: 'a-1' })]);
    getAgents.mockResolvedValue([
      { id: 'local-1', switchAgentId: 'a-1', serverId: 'another-server' },
    ]);
    const backfill = await loadFresh();

    expect(await backfill(server('s-1'))).toEqual({ kind: 'written', written: 0 });
    expect(updateAgentIcon).not.toHaveBeenCalled();
  });

  it('treats a refusal as not-ours rather than a failure', async () => {
    given([agent({ id: 'a-1' })]);
    updateAgentIcon.mockRejectedValueOnce(new FakeGatewayError('http', 'forbidden', 403));
    const backfill = await loadFresh();

    expect(await backfill(server('s-1'))).toEqual({ kind: 'written', written: 0 });
  });

  it('reports a server with no icon endpoint', async () => {
    // Every write 404ing means the route does not exist, not that the agents
    // vanished — they came from that same server one request earlier. The user
    // has to be told, because the app draws its own bots and looks correct.
    given([agent({ id: 'a-1' }), agent({ id: 'a-2' })]);
    updateAgentIcon.mockRejectedValue(new FakeGatewayError('http', 'not found', 404));
    const backfill = await loadFresh();

    expect(await backfill(server('s-1'))).toEqual({ kind: 'unsupported' });
  });

  it('reports the agents that kept the old icon', async () => {
    given([agent({ id: 'a-1' }), agent({ id: 'a-2' }), agent({ id: 'a-3' })]);
    updateAgentIcon.mockRejectedValueOnce(new Error('boom'));
    const backfill = await loadFresh();

    expect(await backfill(server('s-1'))).toEqual({ kind: 'partial', written: 2, failed: 1 });
    expect(updateAgentIcon).toHaveBeenCalledTimes(3);
  });

  it('asks the gateway once per server however often it is called', async () => {
    given([agent({})]);
    const backfill = await loadFresh();

    await backfill(server('s-1'));
    await backfill(server('s-1'));
    await backfill(server('s-1'));

    expect(updateAgentIcon).toHaveBeenCalledTimes(1);
    expect(fetchAgents).toHaveBeenCalledTimes(1);
  });

  it('does not start a second pass while the first is still running', async () => {
    // Two sidebar refreshes can land together on startup; without this each
    // would see no icons yet and write every agent twice.
    let release = (_: RemoteAgentSummary[]) => {};
    getAgents.mockResolvedValue([{ id: 'local-1', switchAgentId: 'a-1', serverId: 's-1' }]);
    fetchAgents.mockReturnValue(
      new Promise<RemoteAgentSummary[]>((resolve) => {
        release = resolve;
      })
    );
    const backfill = await loadFresh();

    const first = backfill(server('s-1'));
    const second = backfill(server('s-1'));
    release([agent({ id: 'a-1' })]);
    await Promise.all([first, second]);

    expect(fetchAgents).toHaveBeenCalledTimes(1);
    expect(updateAgentIcon).toHaveBeenCalledTimes(1);
  });

  it('tries again after a failed pass', async () => {
    // A server unreachable at startup must not be written off for the rest of
    // the run — otherwise its agents keep the lettered avatar until a restart.
    fetchAgents.mockRejectedValueOnce(new Error('offline'));
    const backfill = await loadFresh();

    await expect(backfill(server('s-1'))).rejects.toThrow('offline');

    given([agent({})]);
    expect(await backfill(server('s-1'))).toEqual({ kind: 'written', written: 1 });
  });

  it('handles each server separately', async () => {
    fetchAgents.mockResolvedValue([agent({ id: 'a-1' })]);
    getAgents.mockResolvedValue([
      { id: 'local-1', switchAgentId: 'a-1', serverId: 's-1' },
      { id: 'local-2', switchAgentId: 'a-1', serverId: 's-2' },
    ]);
    const backfill = await loadFresh();

    await backfill(server('s-1'));
    await backfill(server('s-2'));

    expect(updateAgentIcon).toHaveBeenCalledTimes(2);
  });
});
