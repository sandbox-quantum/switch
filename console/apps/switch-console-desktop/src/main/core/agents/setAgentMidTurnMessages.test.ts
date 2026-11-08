import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = { id: string; switchAgentId: string | null };

const calls = vi.hoisted(() => [] as string[]);
const agentRow = vi.hoisted(() => ({ current: undefined as Row | undefined }));
const updateAgent = vi.hoisted(() =>
  vi.fn(async (params: { agentId: string; midTurnMessages?: string }) => {
    const { agentId, ...change } = params;
    calls.push(`row ${JSON.stringify(change)}`);
    return { id: agentId, ...change };
  })
);
const refreshLocalWatcher = vi.hoisted(() =>
  vi.fn(async (_id: string) => void calls.push('refresh'))
);
vi.mock('./getAgentById', () => ({ getAgentById: async () => agentRow.current }));
vi.mock('./updateAgent', () => ({ updateAgent }));
vi.mock('./remote-watcher', () => ({ refreshLocalWatcher }));

import { setAgentMidTurnMessages } from './setAgentMidTurnMessages';

describe('setAgentMidTurnMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    agentRow.current = { id: 'agent-1', switchAgentId: 'sw-1' };
  });

  it("saves the setting, then hands a Switch agent's watcher its new configuration", async () => {
    await setAgentMidTurnMessages({ agentId: 'agent-1', midTurnMessages: 'queue' });
    expect(calls).toEqual(['row {"midTurnMessages":"queue"}', 'refresh']);
  });

  it('only saves it for an agent with no watcher to tell', async () => {
    agentRow.current = { id: 'agent-1', switchAgentId: null };
    await setAgentMidTurnMessages({ agentId: 'agent-1', midTurnMessages: 'steer' });
    expect(calls).toEqual(['row {"midTurnMessages":"steer"}']);
  });

  it('refuses an agent that does not exist', async () => {
    agentRow.current = undefined;
    await expect(
      setAgentMidTurnMessages({ agentId: 'missing', midTurnMessages: 'queue' })
    ).rejects.toThrow('No agent with id missing');
    expect(updateAgent).not.toHaveBeenCalled();
  });
});
