import { useQuery } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';
import type { ChatSummary } from '@shared/core/chats/chats';
import { chatsStore } from './stores/chats';

/**
 * The query for a chat's members, keyed on who the live summary says is in it,
 * so an add, a removal or a swap by anyone reads the list again.
 */
export function chatMembersQueryKey(serverId: string, chat: ChatSummary) {
  return ['chat-members', serverId, chat.roomId, chat.memberUserIds.join(',')] as const;
}

/** The workspace roster, the people a chat can hold; shared with Add participants. */
export function workspaceRosterQuery(serverId: string, tenantId: string | null) {
  return {
    queryKey: ['workspace-members', serverId, tenantId] as const,
    queryFn: () => rpc.chats.workspaceMembers({ serverId, tenantId: tenantId as string }),
    enabled: tenantId !== null,
  };
}

type ChatPerson = { userId: string; name: string; email: string | null };

/**
 * The people of a chat. `members` is everyone in it, the viewer included, with
 * their email from the roster when it has one; `known` adds the rest of the
 * roster, so a message keeps naming someone who has since left.
 */
export function useChatPeople(
  serverId: string,
  chat: ChatSummary | undefined
): { members: ChatPerson[]; known: ChatPerson[] } {
  const members = useQuery({
    queryKey: chat ? chatMembersQueryKey(serverId, chat) : ['chat-members', serverId, null],
    queryFn: () => rpc.chats.members(serverId, (chat as ChatSummary).roomId),
    enabled: chat !== undefined,
  });
  const roster = useQuery(workspaceRosterQuery(serverId, chatsStore.tenantId));
  return knownPeople(members.data ?? [], roster.data ?? []);
}

/** The chat's members with their emails, then everyone else the roster knows. */
export function knownPeople(
  members: { userId: string; name: string }[],
  roster: { userId: string; name: string; email: string | null }[]
): { members: ChatPerson[]; known: ChatPerson[] } {
  const emails = new Map(roster.map((person) => [person.userId, person.email]));
  const inChat = members.map((member) => ({
    userId: member.userId,
    name: member.name,
    email: emails.get(member.userId) ?? null,
  }));
  const ids = new Set(inChat.map((member) => member.userId));
  return {
    members: inChat,
    known: [...inChat, ...roster.filter((person) => !ids.has(person.userId))],
  };
}
