import {
  AddAgentTile,
  AgentCard,
  AgentCardGrid,
} from '@switch-console/chat-ui/components/agent-cards';
import { ServerPage } from '@switch-console/chat-ui/components/server-page';
import { BUDDY_ICON_URL } from '@switch-console/chat-ui/model/switch-buddy';
import { Badge } from '@switch-console/chat-ui/primitives/badge';
import { Button } from '@switch-console/chat-ui/primitives/button';
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@switch-console/chat-ui/primitives/dropdown-menu';
import { Bot, ExternalLink, RotateCcw, Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { CloudMachineCard } from '@renderer/features/cloud-agents/cloud-machine-card';
import { useCloudMachines } from '@renderer/features/cloud-agents/use-cloud-agents';
import { useConfirmDeleteAgent } from '@renderer/features/locations/hooks/use-confirm-delete-agent';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { getLocationStore } from '@renderer/features/locations/stores/location-selectors';
import {
  managedAgentLabel,
  managedAgentState,
} from '@renderer/features/managed-agents/managed-agent-state';
import {
  useMachineLabel,
  useManagedAgents,
  withoutManaged,
} from '@renderer/features/managed-agents/use-managed-agents';
import { refreshSidebarRoomState } from '@renderer/features/sidebar/sidebar-tree-data';
import { expectedBuddyName } from '@renderer/features/switch-buddy/buddy-identity';
import { useBuddyPending } from '@renderer/features/switch-buddy/buddy-pending';
import { buddyPerson } from '@renderer/features/switch-buddy/buddy-person';
import { AgentConnectionIndicator } from '@renderer/features/switch-rooms/connection-health';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { resetAgentErrorText } from '@renderer/lib/errors/reset-agent-error';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { useAgentIconUrl } from '@renderer/lib/stores/use-workspace-agents';
import { SearchInput } from '@renderer/lib/ui/search-input';
import type { Agent } from '@shared/core/agents/agents';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { providerDisplayName } from '@shared/core/providers/agent-provider-registry';
import { homeRedirect } from './home-target';
import { isFrozenServer } from './managed-server-state';
import { matchesNameFilter } from './name-filter';
import { openServerPage } from './open-server-page';
import { ServerSectionTitlebar } from './server-section-titlebar';
import { switchRoomsStore } from './switch-rooms-store';
import { switchServersStore } from './switch-servers-store';

function useServerId(): string {
  return useParams('serverAgents').params.serverId;
}

const ServerAgentsTitlebar = observer(function ServerAgentsTitlebar() {
  return <ServerSectionTitlebar serverId={useServerId()} icon={Bot} label="Your Agents" />;
});

const ServerAgentsPanel = observer(function ServerAgentsPanel() {
  const serverId = useServerId();
  const server = switchServersStore.servers.find((s) => s.id === serverId);
  const showAddAgentModal = useShowModal('addAgentModal');

  // The sidebar reads the same two things, but this page must not be right only
  // when the sidebar happened to be open first.
  useEffect(() => {
    void refreshSidebarRoomState(false);
  }, [serverId]);

  const machines = useCloudMachines(serverId);
  const managed = useManagedAgents(serverId);
  const buddyPending = useBuddyPending(serverId);
  const buddyName = expectedBuddyName(buddyPerson(serverId));
  const [filter, setFilter] = useState('');
  const allAgents = withoutManaged(agentsStore.agentsOnServer(serverId), managed.data);
  const agents = allAgents.filter((agent) => matchesNameFilter([agent.name], filter));
  const managedAgents = (managed.data ?? []).filter((agent) =>
    matchesNameFilter([managedAgentLabel(agent), agent.name], filter)
  );
  const showBuddy = buddyPending && matchesNameFilter([buddyName], filter);
  const any = buddyPending || allAgents.length > 0 || (managed.data?.length ?? 0) > 0;

  return (
    <ServerPage
      width={880}
      title="Your Agents"
      term="agent"
      description={`Your agents created and registered on ${server?.name ?? 'this server'}.`}
    >
      {machines.data
        ?.filter((machine) => machine.state !== 'deleted')
        .map((machine) => (
          <CloudMachineCard key={machine.machine_id} machine={machine} serverId={serverId} />
        ))}
      {machines.error && (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {failureText(machines.error, 'Could not load the cloud machine.')}
        </p>
      )}
      {any && (
        <SearchInput
          containerClassName="mb-4"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter agents by name…"
          aria-label="Filter agents by name"
        />
      )}
      {any && !showBuddy && agents.length === 0 && managedAgents.length === 0 && (
        <p className="mb-3 py-2 text-sm text-foreground-muted">
          No agent here matches “{filter.trim()}”.
        </p>
      )}
      <AgentCardGrid>
        <AddAgentTile
          onClick={() => showAddAgentModal({ entryPoint: 'server_page', machine: null })}
        />
        {showBuddy && <PendingBuddyCard serverId={serverId} name={buddyName} />}
        {agents.map((agent) => (
          <LocalAgentCard key={agent.id} agent={agent} serverId={serverId} />
        ))}
        {managedAgents.map((agent) => (
          <ManagedAgentCard key={agent.agentId} agent={agent} />
        ))}
      </AgentCardGrid>
      {managed.error && !(server && isFrozenServer(server)) && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {failureText(managed.error, 'Could not load managed agents.')}
        </p>
      )}
    </ServerPage>
  );
});

/** A setup entry for switch-buddy, matching the sidebar before the agent exists. */
function PendingBuddyCard({ serverId, name }: { serverId: string; name: string }) {
  const { navigate } = useNavigate();
  return (
    <div className="flex min-h-[184px] flex-col rounded-[11px] bg-[var(--surface-2)] p-[14px]">
      <div className="flex flex-1 items-center justify-center py-1 opacity-60 grayscale">
        <AgentAvatar
          agentId={null}
          name={name}
          iconUrl={BUDDY_ICON_URL}
          serverId={serverId}
          size={66}
        />
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-sm font-medium text-foreground">{name}</span>
        <Badge variant="secondary">Not set up</Badge>
      </div>
      <div className="text-xs text-foreground-muted">Connect an AI provider</div>
      <Button
        size="sm"
        className="mt-2 w-full"
        aria-label={`Set up ${name}`}
        onClick={() => navigate('switchBuddy', { serverId })}
      >
        Set up
      </Button>
    </div>
  );
}

/** A managed agent Console has no row for, as its server lists it. */
function ManagedAgentCard({ agent }: { agent: ManagedAgentView }) {
  const { navigate } = useNavigate();
  const label = managedAgentLabel(agent);
  const state = managedAgentState(agent);
  const provider = providerDisplayName(agent.definition.provider) ?? agent.definition.provider;
  const machine = useMachineLabel(agent);
  return (
    <AgentCard
      label={label}
      avatar={
        <AgentAvatar
          agentId={agent.agentId}
          name={label}
          iconUrl={agent.iconUrl}
          serverId={agent.serverId}
          size={66}
        />
      }
      detail={`${provider} · ${machine ?? 'no machine'}`}
      note={null}
      footer={
        <div
          className={`pointer-events-none px-3.5 pb-3 text-xs ${state.tone === 'problem' ? 'text-destructive' : 'text-foreground-muted'}`}
        >
          {state.label}
        </div>
      }
      actions={null}
      onOpen={() =>
        navigate('managedAgent', {
          serverId: agent.serverId,
          agentId: agent.agentId,
          name: label,
        })
      }
    />
  );
}

const LocalAgentCard = observer(function LocalAgentCard({
  agent,
  serverId,
}: {
  agent: Agent;
  serverId: string;
}) {
  const { navigate } = useNavigate();
  const showConfirmReset = useShowModal('resetAgentModal');
  const confirmDeleteAgent = useConfirmDeleteAgent();
  const { toastPromise } = useToast();

  const location = getLocationStore(agent.locationId);
  const sshHost = location?.data?.sshHost ?? null;
  const label = agent.name || 'Unnamed agent';
  const provider = providerDisplayName(agent.providerId);
  const iconUrl = useAgentIconUrl(agent.workspaceId, agent.switchAgentId);

  const gatewayUrl =
    agent.workspaceId &&
    agent.switchAgentId &&
    switchRoomsStore.gatewayAgentUrl(agent.workspaceId, agent.switchAgentId);

  return (
    <AgentCard
      label={label}
      avatar={
        <AgentAvatar
          agentId={agent.switchAgentId}
          name={label}
          iconUrl={iconUrl}
          serverId={serverId}
          size={66}
        />
      }
      detail={`${provider ? `${provider} · ` : ''}${sshHost ?? 'this computer'}`}
      note={agent.ownerName ? `loaded · by ${agent.ownerName}` : null}
      footer={
        <div className="relative self-start px-3.5 pb-3">
          <AgentConnectionIndicator agent={agent} showLabel />
        </div>
      }
      onOpen={() => navigate('location', { locationId: agent.locationId, agentName: label })}
      // Open in gateway, Reset and Remove. Kept rather than dropped with the
      // table: none of them has another entry point from this page. Starting a
      // session is not here — the sidebar is where sessions begin.
      actions={
        <>
          {gatewayUrl && (
            <DropdownMenuItem onClick={() => void openServerPage(serverId, gatewayUrl)}>
              <ExternalLink className="size-4" />
              Open in gateway
            </DropdownMenuItem>
          )}
          {sshHost != null && (
            <DropdownMenuItem
              onClick={() =>
                showConfirmReset({
                  agentLabel: label,
                  onSuccess: () => {
                    void toastPromise(rpc.agents.resetRemoteAgent({ agentId: agent.id }), {
                      loading: `Resetting ${label}…`,
                      success: `${label} was reset`,
                      error: (error) => {
                        return resetAgentErrorText(error);
                      },
                    });
                  },
                })
              }
            >
              <RotateCcw className="size-4" />
              Reset agent…
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => {
              void confirmDeleteAgent({
                locationId: agent.locationId,
                agentId: agent.id,
                locationLabel: label,
                onDeleted: () => {},
              });
            }}
          >
            <Trash2 className="size-4" />
            Remove agent…
          </DropdownMenuItem>
        </>
      }
    />
  );
});

export const serverAgentsView = {
  WrapView: ({ children }: { children: React.ReactNode; serverId: string }) => <>{children}</>,
  TitlebarSlot: ServerAgentsTitlebar,
  MainPanel: ServerAgentsPanel,
  canActivate: (params: unknown): GuardResult => {
    const serverId =
      typeof params === 'object' && params !== null
        ? (params as { serverId?: unknown }).serverId
        : undefined;
    if (typeof serverId !== 'string') return homeRedirect();
    return { ok: true };
  },
} satisfies ViewDefinition<{ serverId: string }>;
