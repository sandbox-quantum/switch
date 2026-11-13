import type { ChatSummary } from '../contracts/chats';

/** A room an agent is in, as the server lists the agent's rooms. */
export type AgentRoom = { roomId: string; roomName: string; archived: boolean };

/**
 * A person's 1-1 chat with an agent, made in Console or the dashboard, on no
 * messaging app. A shortcut: a summary carries no count of people, so a 1-1
 * chat that gained a second person still matches.
 */
export function isConsoleDirectChatSummary(
  chat: Pick<ChatSummary, 'channelType' | 'bridgeType' | 'agents'>
): boolean {
  return chat.channelType === 'direct' && chat.bridgeType === null && chat.agents.length === 1;
}

/**
 * An agent's conversations, in two lists that never share a room: its 1-1
 * chats made in Console (see `isConsoleDirectChat`), newest first, and every other room it is in, by name — a messaging-app DM and a
 * chat with several agents included, whether or not its membership lists it. Excludes rooms the person lost access to.
 */
export function agentConversations(
  agentChats: readonly ChatSummary[],
  agentRooms: readonly AgentRoom[],
  removed: ReadonlySet<string>
): { direct: ChatSummary[]; rooms: Pick<AgentRoom, 'roomId' | 'roomName'>[] } {
  const direct = agentChats.filter(isConsoleDirectChatSummary);
  const directIds = new Set(direct.map((chat) => chat.roomId));
  const listed = agentRooms.filter(
    (room) => !room.archived && !directIds.has(room.roomId) && !removed.has(room.roomId)
  );
  const listedIds = new Set(agentRooms.map((room) => room.roomId));
  const unlisted = agentChats
    .filter((chat) => !directIds.has(chat.roomId) && !listedIds.has(chat.roomId))
    .map((chat) => ({ roomId: chat.roomId, roomName: chat.name }));
  const rooms = [...listed, ...unlisted].sort((a, b) => a.roomName.localeCompare(b.roomName));
  return { direct, rooms };
}

/**
 * Agents by their newest 1-1 Console chat message, newest first. Agents with
 * no such chat, and ties, keep the order they came in. No chats (flag off or
 * not loaded) leaves the order as it is.
 */
export function byLatestDirectChat<T extends { agentId: string }>(
  agents: readonly T[],
  chats: Iterable<ChatSummary> | null
): T[] {
  if (chats === null) return [...agents];
  const latest = new Map<string, string>();
  for (const chat of chats) {
    if (!chat.lastMessage || !isConsoleDirectChatSummary(chat)) continue;
    const id = chat.agents[0].id;
    if ((latest.get(id) ?? '') < chat.lastMessage.sentAt) latest.set(id, chat.lastMessage.sentAt);
  }
  return [...agents].sort((a, b) =>
    (latest.get(b.agentId) ?? '').localeCompare(latest.get(a.agentId) ?? '')
  );
}
