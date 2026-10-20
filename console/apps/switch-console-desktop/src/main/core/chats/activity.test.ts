import { describe, expect, it } from 'vitest';
import { type ActivityDeps, resolveChatActivity } from './activity';

function deps(overrides: Partial<ActivityDeps>): ActivityDeps {
  return {
    localAgents: async () => [],
    placements: async () => ({}),
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

  it('looks up no session for an agent that does not run here', async () => {
    expect(
      await resolveChatActivity(deps({}), { serverId: 's', agentId: 'theirs', roomId: 'room-1' })
    ).toMatchObject({ kind: 'unavailable', reason: 'not-on-this-machine' });
  });
});
