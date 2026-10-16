import type { LocalAgentTabStore } from '@renderer/features/locations/stores/local-agent-tabs';
import type { AgentTabStore } from '@renderer/features/managed-agents/agent-tab-store';
import { managedAgentLabel } from '@renderer/features/managed-agents/managed-agent-state';
import type { NavigateFnTyped } from '@renderer/lib/layout/navigation-provider';
import type { Agent } from '@shared/core/agents/agents';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';

/**
 * Where an agent named on a connector's profile leads: its Connections tab,
 * on the page this Console shows it on, or nowhere for an agent that lives in
 * another Console.
 */
export type AgentLink =
  | { kind: 'local'; agentId: string; locationId: string; agentName: string }
  | { kind: 'managed'; serverId: string; agentId: string; name: string }
  | { kind: 'elsewhere'; title: string };

export const ELSEWHERE_TITLE =
  'This agent runs from another Switch Console, so it has no page here.';

/**
 * The link for the Switch agent `agentId`. The server runs a managed agent, so
 * one this Console also keeps a local row for opens as managed, the way the
 * sidebar shows it. `managedAgents` is null or undefined while the server has
 * no agent management or the list has not come back.
 */
export function agentLinkFor(
  agentId: string,
  localAgents: readonly Agent[],
  managedAgents: readonly ManagedAgentView[] | null | undefined
): AgentLink {
  const managed = managedAgents?.find((agent) => agent.agentId === agentId);
  if (managed)
    return {
      kind: 'managed',
      serverId: managed.serverId,
      agentId: managed.agentId,
      name: managedAgentLabel(managed),
    };
  const local = localAgents.find((agent) => agent.switchAgentId === agentId);
  if (local)
    return {
      kind: 'local',
      agentId: local.id,
      locationId: local.locationId,
      agentName: local.name,
    };
  return { kind: 'elsewhere', title: ELSEWHERE_TITLE };
}

/** Opens a linked agent's page on its Connections tab. */
export function openAgentConnections(
  link: Exclude<AgentLink, { kind: 'elsewhere' }>,
  navigate: NavigateFnTyped,
  tabs: { local: LocalAgentTabStore; managed: AgentTabStore }
): void {
  if (link.kind === 'local') {
    tabs.local.setTab(link.agentId, 'connections');
    navigate('location', { locationId: link.locationId, agentName: link.agentName });
    return;
  }
  tabs.managed.setTab(link.agentId, 'connections');
  navigate('managedAgent', { serverId: link.serverId, agentId: link.agentId, name: link.name });
}
