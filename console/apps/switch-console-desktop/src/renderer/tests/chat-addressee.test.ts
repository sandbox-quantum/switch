import { describe, expect, it } from 'vitest';
import { mentionAgentIdFor, ROOM_ONLY } from '@renderer/features/chats/addressee';
import type { ChatAgent } from '@shared/core/chats/chats';

const agent = (id: string): ChatAgent => ({
  id,
  name: id,
  displayName: null,
  iconUrl: null,
  provider: null,
});

describe('mentionAgentIdFor', () => {
  const two = [agent('a1'), agent('a2')];

  it('names the selected agent in a chat with several', () => {
    expect(mentionAgentIdFor(two, 'a2')).toBe('a2');
  });

  it('names the chat’s first agent when nothing, or no agent of it, is selected', () => {
    expect(mentionAgentIdFor(two, null)).toBe('a1');
    expect(mentionAgentIdFor(two, 'gone')).toBe('a1');
  });

  it('names nobody when the message is for the room only', () => {
    expect(mentionAgentIdFor(two, ROOM_ONLY)).toBeNull();
  });

  it('names nobody in a direct chat, whose one agent every message addresses', () => {
    expect(mentionAgentIdFor([agent('a1')], 'a1')).toBeNull();
    expect(mentionAgentIdFor([agent('a1')], ROOM_ONLY)).toBeNull();
  });
});
