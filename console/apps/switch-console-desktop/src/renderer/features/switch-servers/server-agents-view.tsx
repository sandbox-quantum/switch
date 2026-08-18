import { Bot, ExternalLink, MoreVertical, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { useConfirmDeleteAgent } from '@renderer/features/locations/hooks/use-confirm-delete-agent';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { getLocationStore } from '@renderer/features/locations/stores/location-selectors';
import { refreshSidebarRoomState } from '@renderer/features/sidebar/sidebar-tree-data';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { useAgentIconUrl } from '@renderer/lib/stores/use-remote-agents';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import type { Agent } from '@shared/core/agents/agents';
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

  // The sidebar reads the same two things, but this page must not be right only
  // when the sidebar happened to be open first.
  useEffect(() => {
    void refreshSidebarRoomState(false);
  }, [serverId]);

  const agents = agentsStore.agentsOnServer(serverId);

  return (
    <ServerPage
      title="Your Agents"
      description={`Agents on ${server?.name ?? 'this server'}. Add one, set how it is addressed, and start sessions.`}
    >
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
          onClick={() => showAddAgentModal({})}
          className="flex min-h-[184px] cursor-pointer items-center justify-center rounded-[11px] border border-dashed border-border text-foreground-muted transition-colors hover:border-border-1 hover:bg-[var(--sel-soft)] hover:text-foreground"
          aria-label="Add agent"
        >
          <Plus className="size-5" />
        </button>
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} serverId={serverId} />
        ))}
      </div>
    </ServerPage>
  );
});

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
  const iconUrl = useAgentIconUrl(serverId, agent.switchAgentId);

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
        </div>
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
                        error: (error) =>
                          `Failed to reset agent: ${error instanceof Error ? error.message : String(error)}`,
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
