import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import type { LocationStore } from '@renderer/features/locations/stores/location';
import type { SessionStore } from '@renderer/features/sessions/stores/session-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import type { Agent } from '@shared/core/agents/agents';

/**
 * What the two sidebar trees agree on: which agents are in scope and which
 * sessions belong to them. Everything past that — how they are nested, what a
 * row does — is the trees' own business and deliberately not shared.
 */

/** An agent paired with its (mounted) location, for the flat sidebar list. */
export type AgentEntry = { agent: Agent; location: LocationStore };

/**
 * A location's agents that the active server's tree should draw.
 *
 * A location is in scope when *some* of its agents are on the active server, but a
 * directory can hold agents for several servers at once — so scope has to be
 * re-applied per agent here. Taking the location's whole list instead drew agents
 * belonging to another server under this one, which read as "onboarding brought
 * them across" when nothing had been onboarded at all (CHOO-2044).
 */
function agentsAtLocationInScope(location: LocationStore): Agent[] {
  const activeServerId = switchServersStore.activeServerId;
  if (!activeServerId) return agentsStore.byLocation.get(location.id) ?? [];
  return agentsStore.agentsOnServerAtLocation(location.id, activeServerId);
}

/**
 * The flat list of agents in the active-server scope. Switch Console shows agents
 * as a flat list — not grouped by directory (CHOO-1440).
 *
 * Newest first, then overlaid with the user's manual drag order: an agent they
 * have positioned stays where they put it, and one they have not sorts after
 * those by recency.
 */
export function scopedAgents(): AgentEntry[] {
  const entries: AgentEntry[] = [];
  for (const location of sidebarStore.filteredLocations) {
    for (const agent of agentsAtLocationInScope(location)) {
      entries.push({ agent, location });
    }
  }
  entries.sort(
    (a, b) =>
      b.agent.createdAt.localeCompare(a.agent.createdAt) || a.agent.name.localeCompare(b.agent.name)
  );
  return sidebarStore.orderAgents(entries, (entry) => entry.agent.id);
}

/**
 * Every agent on the active server, ignoring the agent filters.
 *
 * Room membership is a fact about a room, so the agents a room lists — and the
 * agents whose membership is fetched at all — must not depend on which filters
 * the agent view happens to have set. {@link scopedAgents} is the filtered list
 * and stays the right one for rendering the agent tree itself.
 */
export function agentsInActiveScope(): AgentEntry[] {
  const entries: AgentEntry[] = [];
  for (const location of sidebarStore.orderedLocations) {
    for (const agent of agentsAtLocationInScope(location)) {
      entries.push({ agent, location });
    }
  }
  return entries;
}

/**
 * An agent's visible sessions: the location's sessions it owns. Sessions are
 * paired to their agent by `agent_id` — the authoritative link — not by matching
 * a name frozen into the session's config against the agent's definition. A
 * session whose owning agent no longer matches by name is still shown under its
 * agent instead of silently vanishing (CHOO-1440).
 */
export function agentSessions(entry: AgentEntry): SessionStore[] {
  const all = sidebarStore.visibleSessionsForLocation(entry.location.id);
  return all.filter(
    (session) => 'agentId' in session.data && session.data.agentId === entry.agent.id
  );
}

/** Every agent on the active server that has a Switch identity, as
 * membership-lookup keys. Unfiltered on purpose — see
 * {@link agentsInActiveScope}. */
export function switchIdentities(): { serverId: string; switchAgentId: string }[] {
  const identities: { serverId: string; switchAgentId: string }[] = [];
  for (const { agent } of agentsInActiveScope()) {
    if (agent.serverId && agent.switchAgentId) {
      identities.push({ serverId: agent.serverId, switchAgentId: agent.switchAgentId });
    }
  }
  return identities;
}
