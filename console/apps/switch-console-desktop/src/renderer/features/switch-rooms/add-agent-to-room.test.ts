import { describe, expect, it, vi } from 'vitest';
import type { ChatSummary } from '@shared/core/chats/chats';
import { addAgentToRoom, mayAddToRoom } from './add-agent-to-room';

const group = {
  roomId: 'g',
  channelType: 'channel_private',
  bridgeType: null,
  agents: [],
  canManage: true,
} as unknown as ChatSummary;

function api(chat: ChatSummary | undefined) {
  return {
    chat: () => chat,
    addChatAgent: vi.fn(async () => group),
    addRoomAgents: vi.fn(async () => undefined),
    chatChanged: vi.fn(),
  };
}

describe('addAgentToRoom', () => {
  const input = { serverId: 's', workspaceId: 'w', roomId: 'g', agentId: 'a1' };

  it('adds to a group chat through the chats API', async () => {
    const calls = api(group);
    await addAgentToRoom(calls, input);
    expect(calls.addChatAgent).toHaveBeenCalledWith({ serverId: 's', roomId: 'g', agentId: 'a1' });
    expect(calls.chatChanged).toHaveBeenCalledWith('s', group);
    expect(calls.addRoomAgents).not.toHaveBeenCalled();
  });

  it('adds to a bridged room through the rooms API, and passes on a refusal', async () => {
    const calls = api({ ...group, bridgeType: 'slack' });
    await addAgentToRoom(calls, input);
    expect(calls.addRoomAgents).toHaveBeenCalledWith({
      workspaceId: 'w',
      roomId: 'g',
      agentIds: ['a1'],
      direction: 'room_to_agents',
    });
    calls.addRoomAgents.mockRejectedValueOnce(new Error('refused'));
    await expect(addAgentToRoom(calls, input)).rejects.toThrow('refused');
  });
});

describe('mayAddToRoom', () => {
  it('asks the chat for a chat, and the room rule otherwise', () => {
    expect(mayAddToRoom({ ...group, canManage: false }, true)).toBe(false);
    expect(mayAddToRoom(group, false)).toBe(true);
    expect(mayAddToRoom(undefined, false)).toBe(false);
  });
});
