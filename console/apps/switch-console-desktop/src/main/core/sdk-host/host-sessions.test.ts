/**
 * One session listing per host, not one per agent.
 *
 * This read used to run once per linked agent every 5 seconds, and each run
 * read *every* session directory on the host to keep the few belonging to
 * that agent. Twenty agents on a machine meant twenty SSH commands every five
 * seconds, forever, down a connection that runs four at a time — for twenty
 * near-identical answers. It was the largest standing cost of leaving Console
 * open.
 *
 * So what these tests hold is a count: how many times the host is actually
 * asked. Getting the sessions right matters too, but that was already true;
 * the regression worth catching is the fan-out quietly coming back.
 */

import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  agents: new Map<string, { id: string; switchAgentId: string; locationId: string }>(),
  locations: new Map<string, { sshHost: string | null }>(),
}));

vi.mock('@main/core/agents/getAgentById', () => ({
  getAgentById: async (id: string) => mocks.agents.get(id),
}));
vi.mock('@main/core/agents/agent-location', () => ({
  getAgentLocation: async (agent: { locationId: string }) => mocks.locations.get(agent.locationId),
}));
vi.mock('@main/core/agents/connect-remote-agent', () => ({
  connectRemoteAgent: async () => ({ ctx: { exec: mocks.exec } }),
}));
vi.mock('@main/core/execution-context/local-execution-context', () => ({
  LocalExecutionContext: class {
    exec = mocks.exec;
  },
}));

const { clearHostSessionsCache, listHostSessions } = await import('./host-sessions');

/** What the host script prints: every session on the machine, with its owner. */
function hostReplies(entries: { agentId: string; sessionId: string }[]) {
  mocks.exec.mockImplementation(async () => ({
    stdout: JSON.stringify(
      entries.map((e) => ({
        agentId: e.agentId,
        session: {
          sessionId: e.sessionId,
          agentId: e.agentId,
          provider: 'claude',
          hostId: 'host',
          epoch: 'epoch',
          status: 'running',
          connectivity: 'online',
          pendingRequestIds: [],
          capabilities: {
            input: 'queue',
            approvals: false,
            questions: false,
            interrupt: false,
            reset: false,
            compact: false,
            modelChange: false,
            attachmentMimeTypes: [],
          },
        },
        stopped: false,
        room: null,
        alive: true,
      }))
    ),
    stderr: '',
    exitCode: 0,
  }));
}

function agentOn(id: string, switchAgentId: string, host: string | null) {
  mocks.agents.set(id, { id, switchAgentId, locationId: `loc-${host ?? 'local'}` });
  mocks.locations.set(`loc-${host ?? 'local'}`, { sshHost: host });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  mocks.agents.clear();
  mocks.locations.clear();
  clearHostSessionsCache();
});

it('asks the host once when every agent on it lists at the same moment', async () => {
  for (let i = 1; i <= 20; i++) agentOn(`a${i}`, `switch-a${i}`, 'vm-1');
  hostReplies([{ agentId: 'switch-a7', sessionId: 's7' }]);

  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => listHostSessions(`a${i + 1}`))
  );

  expect(mocks.exec).toHaveBeenCalledTimes(1);
  expect(results[6].map((s) => s.sessionId)).toEqual(['s7']);
});

it('gives each agent only its own sessions', async () => {
  agentOn('a1', 'switch-a1', 'vm-1');
  agentOn('a2', 'switch-a2', 'vm-1');
  hostReplies([
    { agentId: 'switch-a1', sessionId: 'one' },
    { agentId: 'switch-a2', sessionId: 'two' },
    { agentId: 'switch-a1', sessionId: 'three' },
  ]);

  expect((await listHostSessions('a1')).map((s) => s.sessionId).sort()).toEqual(['one', 'three']);
  expect((await listHostSessions('a2')).map((s) => s.sessionId)).toEqual(['two']);
});

it('reports an agent with nothing on the host as having no sessions', async () => {
  // Not "unknown": the read covered every agent on the machine, so an absent
  // agent is a statement rather than a gap.
  agentOn('a1', 'switch-a1', 'vm-1');
  hostReplies([{ agentId: 'someone-else', sessionId: 'x' }]);

  expect(await listHostSessions('a1')).toEqual([]);
});

it('does not share one host’s answer with another host', async () => {
  agentOn('a1', 'switch-a1', 'vm-1');
  agentOn('a2', 'switch-a2', 'vm-2');
  hostReplies([]);

  await Promise.all([listHostSessions('a1'), listHostSessions('a2')]);

  expect(mocks.exec).toHaveBeenCalledTimes(2);
});

it('keeps local agents separate from a remote host', async () => {
  agentOn('local-1', 'switch-local', null);
  agentOn('remote-1', 'switch-remote', 'vm-1');
  hostReplies([]);

  await Promise.all([listHostSessions('local-1'), listHostSessions('remote-1')]);

  expect(mocks.exec).toHaveBeenCalledTimes(2);
});

it('retries after a failure instead of caching the rejection', async () => {
  // A cached failure would leave every agent on the host wedged until the TTL
  // expired, which is the opposite of what a shared read should do.
  agentOn('a1', 'switch-a1', 'vm-1');
  mocks.exec.mockRejectedValueOnce(new Error('connection lost'));

  await expect(listHostSessions('a1')).rejects.toThrow('connection lost');

  hostReplies([{ agentId: 'switch-a1', sessionId: 'back' }]);
  expect((await listHostSessions('a1')).map((s) => s.sessionId)).toEqual(['back']);
});

it('reads again once the listing is stale', async () => {
  vi.useFakeTimers();
  agentOn('a1', 'switch-a1', 'vm-1');
  hostReplies([]);

  await listHostSessions('a1');
  await vi.advanceTimersByTimeAsync(10_000);
  await listHostSessions('a1');

  expect(mocks.exec).toHaveBeenCalledTimes(2);
});
