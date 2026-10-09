import type { WatcherHealth } from '@switch-console/agent-providers';
import { describe, expect, it } from 'vitest';
import { type ActivityDeps, resolveChatActivity } from './activity';

const health = (
  placements: Record<string, string>,
  since = '2026-01-01T00:00:00Z'
): WatcherHealth => ({
  state: 'connected',
  detail: null,
  since,
  placements,
});

function deps(overrides: Partial<ActivityDeps>): ActivityDeps {
  return {
    localAgents: async () => [],
    placements: async () => ({}),
    ownedManagedAgents: async () => [],
    ownsAgent: async () => false,
    relayKey: (serverId, agent) => ({
      key: `controller:${serverId}:agent=${agent.agentId}`,
      cloud: agent.controllerKind === 'ec2',
    }),
    relayHealth: async () => health({}),
    relaySessions: async () => [],
    relayCode: () => null,
    ...overrides,
  };
}

describe('resolveChatActivity', () => {
  it('gives two local agents in one room their own sessions', async () => {
    const d = deps({
      localAgents: async () => [
        { id: 'console-a', switchAgentId: 'agent-a', ssh: false },
        { id: 'console-b', switchAgentId: 'agent-b', ssh: true },
      ],
      placements: async (_server, consoleAgentId): Promise<Record<string, string>> =>
        consoleAgentId === 'console-a'
          ? { 'session-a': 'room-1', 'session-a2': 'room-2' }
          : { 'session-b': 'room-1' },
    });
    const a = await resolveChatActivity(d, { serverId: 's', agentId: 'agent-a', roomId: 'room-1' });
    const b = await resolveChatActivity(d, { serverId: 's', agentId: 'agent-b', roomId: 'room-1' });
    expect(a).toMatchObject({
      kind: 'session',
      target: 'local',
      hostAgentKey: 'console-a',
      sessionId: 'session-a',
    });
    expect(b).toMatchObject({
      kind: 'session',
      target: 'ssh',
      hostAgentKey: 'console-b',
      sessionId: 'session-b',
    });
  });

  it('says a local agent has no session in a room it is not placed in', async () => {
    const d = deps({
      localAgents: async () => [{ id: 'console-a', switchAgentId: 'agent-a', ssh: false }],
      placements: async () => ({ 'session-a': 'room-2' }),
    });
    expect(
      await resolveChatActivity(d, { serverId: 's', agentId: 'agent-a', roomId: 'room-1' })
    ).toMatchObject({ kind: 'unavailable', reason: 'not-placed' });
  });

  it('shows no activity for an agent someone else owns', async () => {
    expect(
      await resolveChatActivity(deps({}), { serverId: 's', agentId: 'theirs', roomId: 'room-1' })
    ).toMatchObject({
      kind: 'unavailable',
      reason: 'not-owner',
      message: 'Agent activity is visible to its owner.',
    });
  });

  it('finds a controller agent session through the relay, keyed by the watcher run', async () => {
    const d = deps({
      ownedManagedAgents: async () => [
        {
          agentId: 'agent-c',
          controllerId: 'ctl-1',
          controllerKind: 'daemon',
          controllerOnline: true,
        },
      ],
      relayHealth: async () => health({ 'session-c': 'room-1' }, '2026-02-02T00:00:00Z'),
    });
    expect(
      await resolveChatActivity(d, { serverId: 's', agentId: 'agent-c', roomId: 'room-1' })
    ).toEqual({
      kind: 'session',
      target: 'controller',
      hostAgentKey: 'controller:s:agent=agent-c',
      sessionId: 'session-c',
      controllerId: 'ctl-1',
      generation: '2026-02-02T00:00:00Z',
      cloud: false,
    });
  });

  it('falls back to the sessions the relay lists with the room', async () => {
    const d = deps({
      ownedManagedAgents: async () => [
        {
          agentId: 'agent-c',
          controllerId: 'ctl-1',
          controllerKind: 'daemon',
          controllerOnline: true,
        },
      ],
      relaySessions: async () =>
        [
          { sessionId: 'old', retired: true, roomIds: ['room-1'] },
          { sessionId: 'current', retired: false, roomIds: ['room-1'] },
        ] as never,
    });
    expect(
      await resolveChatActivity(d, { serverId: 's', agentId: 'agent-c', roomId: 'room-1' })
    ).toMatchObject({ sessionId: 'current' });
  });

  it('offers a wake for a sleeping cloud agent and reports other offline controllers', async () => {
    const managed = (kind: string, online: boolean) => async () => [
      { agentId: 'agent-c', controllerId: 'ctl-1', controllerKind: kind, controllerOnline: online },
    ];
    expect(
      await resolveChatActivity(deps({ ownedManagedAgents: managed('ec2', false) }), {
        serverId: 's',
        agentId: 'agent-c',
        roomId: 'room-1',
      })
    ).toMatchObject({ reason: 'machine-asleep', wakeAgentKey: 'controller:s:agent=agent-c' });
    expect(
      await resolveChatActivity(deps({ ownedManagedAgents: managed('daemon', false) }), {
        serverId: 's',
        agentId: 'agent-c',
        roomId: 'room-1',
      })
    ).toMatchObject({ reason: 'controller-offline', wakeAgentKey: null });
  });
});
