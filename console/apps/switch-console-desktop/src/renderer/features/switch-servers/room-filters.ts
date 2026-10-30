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

/** A Console group chat: an unbridged chat that is not a 1-1 Console chat. It opens as a room. */
export function isConsoleGroupChatSummary(
  chat: Pick<ChatSummary, 'channelType' | 'bridgeType' | 'agents'>
): boolean {
  return chat.bridgeType === null && !isConsoleDirectChatSummary(chat);
}

/**
 * `rooms` and, as rooms, the group chats not among them: the room list holds
 * only rooms you own or that are public, so a person invited to a chat would
 * not see it otherwise.
 */
export function withConsoleGroupChats(
  rooms: RemoteRoomSummary[],
  chats: Iterable<ChatSummary>
): RemoteRoomSummary[] {
  const listed = new Set(rooms.map((room) => room.id));
  const added = [...chats]
    .filter((chat) => isConsoleGroupChatSummary(chat) && !listed.has(chat.roomId))
    .map((chat): RemoteRoomSummary => ({
      id: chat.roomId,
      name: chat.name,
      description: '',
      channelType: chat.channelType,
      agentCount: chat.agents.length,
      bridgeDisplayName: null,
      bridgeType: null,
      externalChannelUrl: null,
      // shortcut: a chat summary names no owner, so a chat-only row offers no delete; read it from the room detail if one is wanted.
      ownerId: null,
      viewerIsMember: true,
      isConsoleChat: true,
      archived: false,
      createdAt: chat.lastMessage?.sentAt ?? '',
    }));
  if (added.length === 0) return rooms;
  return [...rooms, ...added].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Your rooms, then every other room you can read: one list, by name.
 */
export function allReadableRooms(
  yours: RemoteRoomSummary[],
  readable: RemoteRoomSummary[]
): RemoteRoomSummary[] {
  const listed = new Set(yours.map((room) => room.id));
  const more = readable.filter((room) => !listed.has(room.id));
  if (more.length === 0) return yours;
  return [...yours, ...more].sort((a, b) => a.name.localeCompare(b.name));
}
