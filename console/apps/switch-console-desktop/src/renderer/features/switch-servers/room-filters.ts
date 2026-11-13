import type { ChatSummary } from '@switch-console/chat-ui/contracts/chats';
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

/**
 * A room the server marks as a direct Switch Console chat: a person's 1-1 chat
 * with an agent, on no messaging app. Read from the server's own word, so it
 * holds whatever the agent count says (an agent removed from the chat leaves
 * it direct) and whether or not this server's flags have been read.
 */
export function isMarkedConsoleDirectChat(
  room: Pick<RemoteRoomSummary, 'channelType' | 'bridgeType' | 'isConsoleChat'>
): boolean {
  return room.isConsoleChat && room.channelType === 'direct' && room.bridgeType === null;
}

/**
 * Whether the room lists leave a room out as a direct chat. One the server
 * marks is never a room, so it is left out even while agent_chats reads off,
 * as every flag does until the server's flags are read: opened as a room it
 * shows nothing usable. A server too old to mark its chats is read by shape,
 * and only with agent_chats on, where the chat UI shows it instead.
 */
export function isHiddenDirectChat(
  room: Pick<RemoteRoomSummary, 'channelType' | 'bridgeType' | 'agentCount' | 'isConsoleChat'>,
  agentChatsOn: boolean
): boolean {
  return isMarkedConsoleDirectChat(room) || (agentChatsOn && isConsoleDirectChat(room));
}

/**
 * What the room page says, in place of a messaging-app conversation, for a
 * Switch Console chat it is not drawing itself: it has no channel to embed, and
 * is no agent-only room either. Null for any other room.
 */
export function consoleChatNotice(
  room: Pick<RemoteRoomSummary, 'channelType' | 'bridgeType' | 'isConsoleChat'>
): { title: string; detail: string } | null {
  if (!room.isConsoleChat || room.bridgeType !== null) return null;
  if (isMarkedConsoleDirectChat(room))
    return {
      title: 'This is a direct chat with an agent',
      detail:
        'Direct chats open in Switch Console’s chat view, not as a room. Open it from the agent’s page.',
    };
  return {
    title: 'This is a group chat in Switch Console',
    detail:
      'Its conversation shows here once Switch Console has loaded this server’s chats, which needs chats turned on for the server.',
  };
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
      viewerIsRoomAdmin: false,
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
