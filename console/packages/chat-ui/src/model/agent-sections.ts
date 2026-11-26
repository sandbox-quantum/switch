export type AgentSection = 'connections' | 'settings';

const AGENT_SECTIONS: readonly AgentSection[] = ['connections', 'settings'];

export function isAgentSection(value: unknown): value is AgentSection {
  return AGENT_SECTIONS.includes(value as AgentSection);
}

export function agentSections(
  serviceConnections: boolean,
  grants: unknown | null | undefined
): readonly AgentSection[] {
  return serviceConnections && grants !== null ? ['connections', 'settings'] : ['settings'];
}

export function shownAgentSection(
  chosen: AgentSection | undefined,
  sections: readonly AgentSection[]
): AgentSection | null {
  return chosen !== undefined && sections.includes(chosen) ? chosen : null;
}

export function shownAgentRoom(
  chosen: string | undefined,
  section: AgentSection | null,
  rooms: readonly { roomId: string }[] | undefined
): string | null {
  if (chosen === undefined || section !== null) return null;
  return rooms === undefined || rooms.some((room) => room.roomId === chosen) ? chosen : null;
}
