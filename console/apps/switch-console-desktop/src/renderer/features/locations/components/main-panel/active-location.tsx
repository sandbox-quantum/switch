import { observer } from 'mobx-react-lite';
import { AgentEditsProvider } from '@renderer/features/locations/components/main-panel/agent-edits';
import { AgentPageHeader } from '@renderer/features/locations/components/main-panel/agent-page-header';
import { AgentSaveBar } from '@renderer/features/locations/components/main-panel/agent-save-bar';
import { SessionList } from '@renderer/features/locations/components/session-view/session-list';
import { SettingsPanel } from '@renderer/features/locations/components/settings-view/settings-panel';
import { SidecarPanel } from '@renderer/features/locations/components/settings-view/sidecar-panel';
import { useLocalAgentTab } from '@renderer/features/locations/hooks/use-local-agent-tab';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import {
  asMounted,
  getLocationStore,
} from '@renderer/features/locations/stores/location-selectors';
import { AgentConnectionsTab } from '@renderer/features/managed-agents/agent-connections-tab';
import { useParams } from '@renderer/lib/layout/navigation-provider';

/**
 * An agent, on one page: who it is, how it behaves, the process keeping it
 * connected, and its sessions — read top to bottom.
 *
 * It used to be three tabs down a side nav, which asked the reader to know
 * which of them held what before they could look at anything. The page is short
 * enough to scroll instead. The one exception is Connections, a page of its
 * own as on a managed agent's page, for an agent registered on a server with
 * service connections on.
 */
export const ActiveLocation = observer(function ActiveLocation() {
  const {
    params: { locationId, agentName },
  } = useParams('location');
  const store = asMounted(getLocationStore(locationId));
  const agent = agentsStore.agentAtLocation(locationId, agentName);
  const { tab } = useLocalAgentTab(agent);

  if (!store) return null;
  if (tab === 'connections' && agent?.workspaceId && agent.switchAgentId)
    return (
      <AgentConnectionsTab
        key={agent.id}
        workspaceId={agent.workspaceId}
        agentId={agent.switchAgentId}
        agentName={agent.name}
        cloud={false}
      />
    );

  return (
    <AgentEditsProvider>
      <div className="flex min-h-0 w-full flex-1 flex-col">
        <AgentSaveBar />
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[900px] flex-col gap-10 px-8 pb-20">
            <AgentPageHeader />
            <SettingsPanel />
            <SidecarPanel />
            <SessionList />
          </div>
        </div>
      </div>
    </AgentEditsProvider>
  );
});
