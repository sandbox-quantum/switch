import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import type { ChatAgent, ChatSummary } from '@shared/core/chats/chats';

export type SidebarAgent = { id: string; name: string; iconUrl: string | null };

/**
 * The agents a chat is listed under. A person who owns one of its agents is in
 * the room because of that agent — often a messaging-app channel full of other
 * people's agents — so it goes under their own agents only. Otherwise, or
 * before their agents are known, it goes under every agent in it.
 */
export function listingAgents(chat: ChatSummary, ownedIds: ReadonlySet<string>): ChatAgent[] {
  if (chat.ownsAgent) {
    const mine = chat.agents.filter((agent) => ownedIds.has(agent.id));
    if (mine.length > 0) return mine;
  }
  return chat.agents;
}

/**
 * The agents to list: those a chat is listed under, then the ones they own
 * with no chat yet — from the server, so an agent run by a controller with no
 * row on this machine is listed like any other.
 */
export function sidebarAgents(
  chats: ChatSummary[],
  owned: { id: string; name: string; displayName: string | null; iconUrl: string | null }[]
): SidebarAgent[] {
  const ownedIds = new Set(owned.map((agent) => agent.id));
  const agents = new Map<string, SidebarAgent>();
  const add = (agent: Pick<ChatAgent, 'id' | 'name' | 'displayName' | 'iconUrl'>) => {
    if (!agents.has(agent.id))
      agents.set(agent.id, {
        id: agent.id,
        name: agent.displayName ?? agent.name,
        iconUrl: agent.iconUrl,
      });
  };
  for (const chat of chats) for (const agent of listingAgents(chat, ownedIds)) add(agent);
  for (const agent of owned) add(agent);
  return [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * How a chat's row names it: a messaging-app room by its channel ("#general")
 * with the app beside it, any other room by its own name.
 */
export function chatRowLabel(chat: ChatSummary): { name: string; platform: string | null } {
  if (!chat.bridgeType) return { name: chat.name, platform: null };
  const channel = chat.channelName ?? chat.name;
  const name = chat.channelType === 'direct' || channel.startsWith('#') ? channel : `#${channel}`;
  return { name, platform: bridgePlatformLabel(chat.bridgeType) };
}
