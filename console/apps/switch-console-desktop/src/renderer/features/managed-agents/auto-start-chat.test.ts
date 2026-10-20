import { describe, expect, it } from 'vitest';
import { shouldAutoStartChat } from './auto-start-chat';

const READY = {
  listed: true,
  listFailed: false,
  hasDirectChats: false,
  selected: false,
  tried: false,
};

describe('shouldAutoStartChat', () => {
  it('starts a chat for a listed agent with no direct chats and nothing selected', () => {
    expect(shouldAutoStartChat(READY)).toBe(true);
  });

  it.each([
    ['chats are still loading', { listed: false }],
    ['the chat list failed', { listFailed: true }],
    ['the agent has a direct chat', { hasDirectChats: true }],
    ['something is selected', { selected: true }],
    ['a start was already tried', { tried: true }],
  ])('does not start when %s', (_, change) => {
    expect(shouldAutoStartChat({ ...READY, ...change })).toBe(false);
  });
});
