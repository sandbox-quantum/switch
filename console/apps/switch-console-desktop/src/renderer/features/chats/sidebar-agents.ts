import type { ChatAgent, ChatSummary } from '@shared/core/chats/chats';

export type SidebarAgent = { id: string; name: string; iconUrl: string | null };

/**
 * The agents to list: those in one of the person's chats, then the ones they
 * own with no chat yet — from the server, so an agent run by a controller
 * with no row on this machine is listed like any other.
 */
export function sidebarAgents(
  chats: ChatSummary[],
  owned: { id: string; name: string; displayName: string | null; iconUrl: string | null }[]
): SidebarAgent[] {
  const agents = new Map<string, SidebarAgent>();
  const add = (agent: Pick<ChatAgent, 'id' | 'name' | 'displayName' | 'iconUrl'>) => {
    if (!agents.has(agent.id))
      agents.set(agent.id, {
        id: agent.id,
        name: agent.displayName ?? agent.name,
        iconUrl: agent.iconUrl,
      });
  };
  for (const chat of chats) for (const agent of chat.agents) add(agent);
  for (const agent of owned) add(agent);
  return [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
}
