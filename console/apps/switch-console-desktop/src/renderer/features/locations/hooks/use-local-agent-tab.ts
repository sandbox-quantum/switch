import {
  localAgentTabs,
  localAgentTabStore,
  shownLocalAgentTab,
} from '@renderer/features/locations/stores/local-agent-tabs';
import { useAgentServiceGrants } from '@renderer/features/managed-agents/agent-connections-tab';
import { useFeatureFlags } from '@renderer/lib/hooks/useFeatureFlags';
import type { Agent } from '@shared/core/agents/agents';

/** The tabs a local agent's page offers, or null for none, and which tab is showing. */
export function useLocalAgentTab(agent: Agent | null) {
  const serviceConnections = useFeatureFlags(agent?.serverId).service_connections;
  const registered = agent?.workspaceId != null && agent.switchAgentId !== null;
  const grants = useAgentServiceGrants(
    serviceConnections && registered,
    agent?.workspaceId ?? null,
    agent?.switchAgentId ?? ''
  );
  const tabs = localAgentTabs(registered, serviceConnections, grants.data);
  const chosen = agent ? localAgentTabStore.tabFor(agent.id) : 'overview';
  return { tabs, tab: shownLocalAgentTab(chosen, tabs) };
}
