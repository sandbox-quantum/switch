import type { ChatSummary } from '@shared/core/chats/chats';
import type { RemoteRoomSummary } from '@shared/core/switch-servers/switch-servers';

/**
 * A 1-1 Console chat: a direct room with exactly one agent and no
 * messaging-app bridge. With agent_chats on, it shows in the chat UI and not
 * as a room.
 * shortcut: room and chat summaries carry no human count, so a 1-1 chat that
 * gained a second person still matches; check members when a summary has them.
 */
export function isConsoleDirectChat(
  room: Pick<RemoteRoomSummary, 'channelType' | 'bridgeType' | 'agentCount'>
): boolean {
  return room.channelType === 'direct' && room.bridgeType === null && room.agentCount === 1;
}

/** {@link isConsoleDirectChat} for a chat summary. */
export function isConsoleDirectChatSummary(
  chat: Pick<ChatSummary, 'channelType' | 'bridgeType' | 'agents'>
): boolean {
  return isConsoleDirectChat({ ...chat, agentCount: chat.agents.length });
}
