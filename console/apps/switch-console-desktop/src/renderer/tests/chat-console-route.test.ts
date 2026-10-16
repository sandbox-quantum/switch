import { describe, expect, it } from 'vitest';
import { consoleChatRoute } from '@renderer/features/chats/console-chat-route';

const helper = { id: 'agent-1', name: 'helper', displayName: 'Helper' };

describe('consoleChatRoute', () => {
  it("opens a managed agent's chat on its agent page", () => {
    expect(consoleChatRoute('s', 'r', helper, true)).toEqual({
      viewId: 'managedAgent',
      params: { serverId: 's', agentId: 'agent-1', name: 'Helper', roomId: 'r' },
    });
  });

  it('opens any other agent’s chat on its own', () => {
    expect(consoleChatRoute('s', 'r', helper, false)).toEqual({
      viewId: 'chat',
      params: { serverId: 's', roomId: 'r', agentId: 'agent-1' },
    });
  });
});
