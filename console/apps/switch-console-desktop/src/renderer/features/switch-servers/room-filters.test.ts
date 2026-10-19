import { describe, expect, it } from 'vitest';
import { isConsoleDirectChat, isConsoleDirectChatSummary } from './room-filters';

const agent = { id: 'a', name: 'a', displayName: null, iconUrl: null, provider: null };

describe('isConsoleDirectChat', () => {
  it('returns true for a direct unbridged room with one agent', () => {
    expect(isConsoleDirectChat({ channelType: 'direct', bridgeType: null, agentCount: 1 })).toBe(
      true
    );
  });

  it('returns false for a direct unbridged room with no agent or several', () => {
    expect(isConsoleDirectChat({ channelType: 'direct', bridgeType: null, agentCount: 0 })).toBe(
      false
    );
    expect(isConsoleDirectChat({ channelType: 'direct', bridgeType: null, agentCount: 2 })).toBe(
      false
    );
  });

  it('returns false for direct bridged rooms', () => {
    expect(isConsoleDirectChat({ channelType: 'direct', bridgeType: 'slack', agentCount: 1 })).toBe(
      false
    );
  });

  it('returns false for non-direct rooms', () => {
    for (const channelType of ['channel_public', 'channel_private', 'group', 'lobby', null])
      expect(isConsoleDirectChat({ channelType, bridgeType: null, agentCount: 1 })).toBe(false);
  });
});

describe('isConsoleDirectChatSummary', () => {
  it('counts the agents of a chat summary', () => {
    expect(
      isConsoleDirectChatSummary({ channelType: 'direct', bridgeType: null, agents: [agent] })
    ).toBe(true);
    expect(
      isConsoleDirectChatSummary({
        channelType: 'direct',
        bridgeType: null,
        agents: [agent, { ...agent, id: 'b' }],
      })
    ).toBe(false);
  });
});
