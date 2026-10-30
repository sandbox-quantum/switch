import { isConsoleGroupChatSummary } from '@renderer/features/switch-servers/room-filters';
import type { ChatSummary } from '@shared/core/chats/chats';

export type AddAgentToRoomApi = {
  /** The chat behind a room, when it is one of the user's chats. */
  chat: (roomId: string) => ChatSummary | undefined;
  addChatAgent: (input: {
    serverId: string;
    roomId: string;
    agentId: string;
  }) => Promise<ChatSummary>;
  addRoomAgents: (input: {
    workspaceId: string;
    roomId: string;
    agentIds: string[];
    direction: 'room_to_agents';
  }) => Promise<unknown>;
  /** Told the chat as the server returned it, once an agent joins a chat. */
  chatChanged: (serverId: string, chat: ChatSummary) => void;
};

/**
 * Puts an agent in a room through the API that owns it: the chats API for a
 * Switch Console group chat, the rooms API for any other room. Throws the
 * server's refusal.
 */
export async function addAgentToRoom(
  api: AddAgentToRoomApi,
  input: { serverId: string; workspaceId: string; roomId: string; agentId: string }
): Promise<void> {
  const chat = api.chat(input.roomId);
  if (chat && isConsoleGroupChatSummary(chat)) {
    api.chatChanged(
      input.serverId,
      await api.addChatAgent({
        serverId: input.serverId,
        roomId: input.roomId,
        agentId: input.agentId,
      })
    );
    return;
  }
  await api.addRoomAgents({
    workspaceId: input.workspaceId,
    roomId: input.roomId,
    agentIds: [input.agentId],
    direction: 'room_to_agents',
  });
}

/** Whether the user may add to a room: a chat they manage, or a room they own or administer. */
export function mayAddToRoom(chat: ChatSummary | undefined, canManageRoom: boolean): boolean {
  return chat && isConsoleGroupChatSummary(chat) ? chat.canManage : canManageRoom;
}
