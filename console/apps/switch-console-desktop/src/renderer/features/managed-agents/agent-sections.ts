import type { ServiceGrants } from '@shared/core/switch-servers/service-grants';

/** What an agent's page shows in place of a chat, picked from its navigation. */
export type AgentSection = 'connections' | 'settings';

const AGENT_SECTIONS: readonly AgentSection[] = ['connections', 'settings'];

export function isAgentSection(value: unknown): value is AgentSection {
  return AGENT_SECTIONS.includes(value as AgentSection);
}

/**
 * The sections a managed agent's page offers. Connections needs the server's
 * `service_connections` flag, and goes once the server answers the agent's
 * grants with null: they are not the caller's, so there is nothing to show.
 * While the grants load it is offered, since this page lists only the
 * caller's own agents.
 */
export function agentSections(
  serviceConnections: boolean,
  grants: ServiceGrants | null | undefined
): readonly AgentSection[] {
  return serviceConnections && grants !== null ? ['connections', 'settings'] : ['settings'];
}

/** The section to show: the one chosen, or none (a chat) when it is not offered. */
export function shownAgentSection(
  chosen: AgentSection | undefined,
  sections: readonly AgentSection[]
): AgentSection | null {
  return chosen !== undefined && sections.includes(chosen) ? chosen : null;
}

/**
 * The room whose summary shows: the one chosen, unless a section shows instead
 * or the agent is no longer in it. While its rooms load it is taken on trust,
 * so a reopened page does not flash a chat first.
 */
export function shownAgentRoom(
  chosen: string | undefined,
  section: AgentSection | null,
  rooms: readonly { roomId: string }[] | undefined
): string | null {
  if (chosen === undefined || section !== null) return null;
  return rooms === undefined || rooms.some((room) => room.roomId === chosen) ? chosen : null;
}
