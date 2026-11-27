import {
  addAgentToRoom as sharedAddAgentToRoom,
  mayAddToRoom as sharedMayAddToRoom,
  type AddAgentToRoomApi,
} from '@switch-console/chat-ui/model/add-agent-to-room';
import { forgetBuddyChat } from '@renderer/features/switch-buddy/buddy-chat';
import { isConsoleGroupChatSummary } from '@renderer/features/switch-servers/room-filters';

export type { AddAgentToRoomApi };

/**
 * Puts an agent in a room through the API that owns it (the shared
 * `addAgentToRoom`), a direct chat with switch-buddy among them. Either way the
 * room is no longer one the buddy has alone, for its usage reports.
 */
export async function addAgentToRoom(
  api: AddAgentToRoomApi,
  input: { serverId: string; workspaceId: string; roomId: string; agentId: string }
): Promise<void> {
  await sharedAddAgentToRoom(api, input, isConsoleGroupChatSummary);
  forgetBuddyChat(input.serverId, input.roomId);
}

export function mayAddToRoom(
  chat: Parameters<typeof sharedMayAddToRoom>[0],
  canManageRoom: boolean
): boolean {
  return sharedMayAddToRoom(chat, canManageRoom, isConsoleGroupChatSummary);
}
