import { Bot, ExternalLink, MoreVertical, Plug, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
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
  useManagedAgents,
  useOwnedMachines,
  withoutManaged,
} from '@renderer/features/managed-agents/use-managed-agents';
import { refreshSidebarRoomState } from '@renderer/features/sidebar/sidebar-tree-data';
import { AgentConnectionIndicator } from '@renderer/features/switch-rooms/connection-health';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { resetAgentErrorText } from '@renderer/lib/errors/reset-agent-error';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { useAgentIconUrl } from '@renderer/lib/stores/use-workspace-agents';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import type { Agent } from '@shared/core/agents/agents';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { providerDisplayName } from '@shared/core/providers/agent-provider-registry';
import { ServerPage } from './server-page';
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
  const showConnectionsModal = useShowModal('connectionsModal');

  // The sidebar reads the same two things, but this page must not be right only
  // when the sidebar happened to be open first.
  useEffect(() => {
    void refreshSidebarRoomState(false);
  }, [serverId]);

  const machines = useCloudMachines(serverId);
  const managed = useManagedAgents(serverId);
  const agents = withoutManaged(agentsStore.agentsOnServer(serverId), managed.data);

  return (
    <ServerPage
      width={880}
      title="Your Agents"
      description={`Agents on ${server?.name ?? 'this server'}. Add one, set how it is addressed, and start sessions.`}
      action={
        machines.data && (
          <Button variant="outline" size="sm" onClick={() => showConnectionsModal({ serverId })}>
            <Plug className="size-4" />
            Connections
          </Button>
        )
      }
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
      {/* The add tile leads the grid rather than sitting as a button in the
          page header: it is the same kind of thing as the cards after it, and
          on an empty server it is the only thing on screen, which says what to
          do without needing an empty-state sentence.

          Four columns at the design's content width, reflowing narrower rather
          than squashing. The height is a floor rather than a ratio, so a card
          keeps its shape as the column width changes. */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-[14px]">
        <button
          type="button"
          onClick={() => showAddAgentModal({ entryPoint: 'server_page' })}
          className="flex min-h-[184px] cursor-pointer items-center justify-center rounded-[11px] border border-dashed border-border text-foreground-muted transition-colors hover:border-border-1 hover:bg-[var(--sel-soft)] hover:text-foreground"
          aria-label="Add agent"
        >
          <Plus className="size-5" />
        </button>
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} serverId={serverId} />
        ))}
        {managed.data?.map((agent) => (
          <ManagedAgentCard key={agent.agentId} agent={agent} />
        ))}
      </div>
      {managed.error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {failureText(managed.error, 'Could not load managed agents.')}
        </p>
      )}
    </ServerPage>
  );
});

/** A managed agent Console has no row for, as its server lists it. */
function ManagedAgentCard({ agent }: { agent: ManagedAgentView }) {
  const { navigate } = useNavigate();
  const label = managedAgentLabel(agent);
  const machines = useOwnedMachines(agent.serverId);
  const machine = machines.data?.find((candidate) => candidate.id === agent.machine?.id) ?? null;
  const state = managedAgentState(agent, machine);
  const provider = providerDisplayName(agent.definition.provider) ?? agent.definition.provider;
  return (
    <div className="group relative flex min-h-[184px] flex-col rounded-[11px] bg-[var(--surface-2)] transition-colors hover:bg-[var(--fill)]">
      <button
        type="button"
        aria-label={`Open ${label}`}
        className="focus-visible:ring-ring absolute inset-0 cursor-pointer rounded-[11px] focus-visible:ring-2 focus-visible:outline-none"
        onClick={() =>
          navigate('managedAgent', {
            serverId: agent.serverId,
            agentId: agent.agentId,
            name: label,
          })
        }
      />
      <div className="pointer-events-none flex flex-1 flex-col p-[14px]">
        <div className="flex flex-1 items-center justify-center py-3">
          <AgentAvatar name={label} iconUrl={agent.iconUrl} size={66} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">{label}</div>
          <div className="truncate text-xs text-foreground-muted">
            {provider} · {agent.machine?.name ?? 'no machine'}
          </div>
        </div>
      </div>
      <div
        className={`pointer-events-none px-3.5 pb-3 text-xs ${state.tone === 'problem' ? 'text-destructive' : 'text-foreground-muted'}`}
      >
        {state.label}
      </div>
    </div>
  );
}

const AgentCard = observer(function AgentCard({
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
    agent.switchAgentId && switchRoomsStore.gatewayAgentUrl(serverId, agent.switchAgentId);

  return (
    <div className="group relative flex min-h-[184px] flex-col rounded-[11px] bg-[var(--surface-2)] transition-colors hover:bg-[var(--fill)]">
      {/* One real button covering the card, so the whole tile is the target and
          screen readers get a single named control rather than a grid of
          nested ones. The visible content below it is inert; the actions after
          it sit on top and keep their own clicks. */}
      <button
        type="button"
        aria-label={`Open ${label}`}
        className="focus-visible:ring-ring absolute inset-0 cursor-pointer rounded-[11px] focus-visible:ring-2 focus-visible:outline-none"
        onClick={() => navigate('location', { locationId: agent.locationId, agentName: label })}
      />

      <div className="pointer-events-none flex flex-1 flex-col p-[14px]">
        <div className="flex flex-1 items-center justify-center py-3">
          <AgentAvatar name={label} iconUrl={iconUrl} size={66} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">{label}</div>
          <div className="truncate text-xs text-foreground-muted">
            {provider ? `${provider} · ` : ''}
            {sshHost ?? 'this computer'}
          </div>
          {agent.ownerName && (
            <div className="truncate text-xs text-foreground-tertiary-passive">
              loaded · by {agent.ownerName}
            </div>
          )}
        </div>
      </div>

      <div className="relative self-start px-3.5 pb-3">
        <AgentConnectionIndicator agent={agent} showLabel />
      </div>

      {/* Open in gateway, Reset and Remove, on hover. Kept rather than dropped
          with the table: none of them has another entry point from this page.
          Starting a session is not here — the sidebar is where sessions begin. */}
      <div className="absolute top-2 right-2 flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="icon-xs" aria-label={`${label} actions`}>
                <MoreVertical className="size-3" />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            {gatewayUrl && (
              <DropdownMenuItem
                onClick={() =>
                  void rpc.switchServers.openGatewayPage({ serverId, url: gatewayUrl })
                }
              >
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
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
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
    if (typeof serverId !== 'string') return { ok: false, redirect: 'home' };
    return { ok: true };
  },
} satisfies ViewDefinition<{ serverId: string }>;
