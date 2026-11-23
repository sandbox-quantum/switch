import type { QueryClient } from '@tanstack/react-query';
import { MANAGED_AGENTS_KEY } from '@renderer/features/managed-agents/use-managed-agents-key';
import type { ChatSummary } from '@shared/core/chats/chats';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { isBuddy } from './buddy-identity';

type OwnAgent = Pick<ManagedAgentView, 'agentId' | 'name' | 'template'>;

/**
 * How long a chat opened as the buddy's own is taken as one without the chats
 * list to check it against: long enough for the first messages after it is
 * opened, the moment this exists for, and short enough that a chat made a
 * group from elsewhere meanwhile is not counted for long.
 */
export const REMEMBERED_BUDDY_CHAT_MS = 30 * 60_000;

/** The chats opened as a buddy's own, by server and room: the buddy each was opened with, and when. */
const openedWithBuddy = new Map<string, { buddyId: string; at: number }>();

const roomKey = (serverId: string, roomId: string) => `${serverId}\u0000${roomId}`;

/**
 * Notes that this chat was found or made as the buddy's own, with the buddy
 * alone in it, so a message sent there counts as one to the buddy even where
 * the chats list does not hold the chat (another server than the one it
 * follows, or before it has caught up), for {@link REMEMBERED_BUDDY_CHAT_MS}.
 */
export function rememberBuddyChat(
  serverId: string,
  roomId: string,
  buddyId: string,
  now: number
): void {
  openedWithBuddy.set(roomKey(serverId, roomId), { buddyId, at: now });
}

/** Someone else was added to the chat: it is no longer the buddy's alone. */
export function forgetBuddyChat(serverId: string, roomId: string): void {
  openedWithBuddy.delete(roomKey(serverId, roomId));
}

/** The buddy a chat was opened with (`rememberBuddyChat`) if that was recent enough, or null. */
export function rememberedBuddy(serverId: string, roomId: string, now: number): string | null {
  const entry = openedWithBuddy.get(roomKey(serverId, roomId));
  if (!entry || now - entry.at > REMEMBERED_BUDDY_CHAT_MS) return null;
  return entry.buddyId;
}

/**
 * Whether a message in this chat goes to the person's own switch-buddy: the
 * chat is a direct one, its one agent their buddy, and no other person in
 * it. A group chat does not count, even with the buddy its only agent.
 *
 * `chat` is the chat as the chats list holds it, when it does. Its agent is
 * the buddy when it is the one the chat was opened with (`remembered`); else
 * when the person's managed agents (`ownAgents`, null when their list is not
 * read yet) name it as one by the template run that made it; else, with no
 * list to go by, when it is one of theirs named as buddies are. A chat the
 * list does not hold counts only when it was opened with the buddy.
 */
export function isBuddyChat(
  chat: Pick<ChatSummary, 'agents' | 'channelType'> | undefined,
  ownAgents: readonly OwnAgent[] | null,
  remembered: string | null
): boolean {
  if (!chat) return remembered !== null;
  const agent = chat.channelType === 'direct' && chat.agents.length === 1 ? chat.agents[0] : null;
  if (!agent) return false;
  if (agent.id === remembered) return true;
  if (ownAgents) {
    const own = ownAgents.find((candidate) => candidate.agentId === agent.id);
    return own !== undefined && isBuddy(own);
  }
  return agent.ownedByViewer && isBuddy({ name: agent.name });
}

/**
 * The person's managed agents as the shared list last read them, from the
 * cache only: the key `useManagedAgents` reads (server, the workspace in
 * scope there, the signed-in user), so another account's or workspace's list
 * left in the cache, or the machines kept under the same prefix, is not.
 * Null when that list has not been read, or the server has no agent
 * management.
 */
export function cachedOwnAgents(
  queryClient: QueryClient,
  serverId: string,
  workspaceId: string | null,
  userId: string | null
): OwnAgent[] | null {
  if (workspaceId === null || userId === null) return null;
  const agents = queryClient.getQueryData<unknown>([
    MANAGED_AGENTS_KEY,
    serverId,
    workspaceId,
    userId,
  ]);
  return Array.isArray(agents) ? (agents as OwnAgent[]) : null;
}
