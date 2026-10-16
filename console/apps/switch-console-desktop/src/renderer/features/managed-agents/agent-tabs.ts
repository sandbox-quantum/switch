import type { ServiceGrants } from '@shared/core/switch-servers/service-grants';
import type { AgentTab } from './agent-tab-store';

export type AgentTabOption = { value: AgentTab; label: string };

const CHATS: AgentTabOption = { value: 'chats', label: 'Chats' };
const CONNECTIONS: AgentTabOption = { value: 'connections', label: 'Connections' };
const SETTINGS: AgentTabOption = { value: 'settings', label: 'Settings' };

/**
 * The tabs a managed agent's page offers. Connections needs the server's
 * `service_connections` flag, and goes once the server answers the agent's
 * grants with null: they are not the caller's, so there is nothing to show.
 * While the grants load it is offered, since this page lists only the
 * caller's own agents.
 */
export function agentTabs(
  serviceConnections: boolean,
  grants: ServiceGrants | null | undefined
): readonly AgentTabOption[] {
  return serviceConnections && grants !== null ? [CHATS, CONNECTIONS, SETTINGS] : [CHATS, SETTINGS];
}

/** The tab to show: the one chosen, or Chats when the chosen one is not offered. */
export function shownAgentTab(chosen: AgentTab, tabs: readonly AgentTabOption[]): AgentTab {
  return tabs.some((tab) => tab.value === chosen) ? chosen : 'chats';
}
