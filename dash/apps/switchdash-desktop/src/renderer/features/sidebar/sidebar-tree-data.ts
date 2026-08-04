import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import type { LocationStore } from '@renderer/features/locations/stores/location';
import type { SessionStore } from '@renderer/features/sessions/stores/session-store';
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
 * The flat list of agents in the active-server scope, newest first. switchdash
 * shows agents as a flat list — not grouped by directory (CHOO-1440).
 */
export function scopedAgents(): AgentEntry[] {
  const entries: AgentEntry[] = [];
  for (const location of sidebarStore.filteredLocations) {
    for (const agent of agentsStore.byLocation.get(location.id) ?? []) {
      entries.push({ agent, location });
    }
  }
  return entries.sort(
    (a, b) =>
      b.agent.createdAt.localeCompare(a.agent.createdAt) || a.agent.name.localeCompare(b.agent.name)
  );
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

/** Every scoped agent that has a Switch identity, as membership-lookup keys. */
export function switchIdentities(): { serverId: string; switchAgentId: string }[] {
  const identities: { serverId: string; switchAgentId: string }[] = [];
  for (const { agent } of scopedAgents()) {
    if (agent.serverId && agent.switchAgentId) {
      identities.push({ serverId: agent.serverId, switchAgentId: agent.switchAgentId });
    }
  }
  return identities;
}
