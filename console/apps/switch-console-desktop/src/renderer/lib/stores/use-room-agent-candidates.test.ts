import { describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/lib/ipc', () => ({ rpc: {} }));

const { invitableAgents } = await import('./use-room-agent-candidates');

const AGENTS = [{ id: 'a-1' }, { id: 'a-2' }, { id: 'a-3' }];

describe('invitableAgents', () => {
  it('keeps only the agents the server says may be invited', () => {
    expect(invitableAgents(AGENTS, ['a-3', 'a-1'])).toEqual([{ id: 'a-1' }, { id: 'a-3' }]);
  });

  it('offers none when the server says none', () => {
    expect(invitableAgents(AGENTS, [])).toEqual([]);
  });

  it('offers every agent when the server cannot say', () => {
    expect(invitableAgents(AGENTS, null)).toEqual(AGENTS);
    expect(invitableAgents(AGENTS, undefined)).toEqual(AGENTS);
  });
});
