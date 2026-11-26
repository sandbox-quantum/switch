/**
 * Adding an agent to a room through the right API: chats for console group
 * chats, rooms for everything else. Pure logic with injected API calls.
 */

import type { ChatSummary } from '../contracts/chats';

export type AddAgentToRoomApi = {
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
  chatChanged: (serverId: string, chat: ChatSummary) => void;
};

export async function addAgentToRoom(
  api: AddAgentToRoomApi,
  input: { serverId: string; workspaceId: string; roomId: string; agentId: string },
  isConsoleGroupChat: (chat: ChatSummary) => boolean
): Promise<void> {
  const chat = api.chat(input.roomId);
  if (chat && isConsoleGroupChat(chat)) {
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

export function mayAddToRoom(
  chat: ChatSummary | undefined,
  canManageRoom: boolean,
  isConsoleGroupChat: (chat: ChatSummary) => boolean
): boolean {
  return chat && isConsoleGroupChat(chat) ? chat.canManage : canManageRoom;
}
