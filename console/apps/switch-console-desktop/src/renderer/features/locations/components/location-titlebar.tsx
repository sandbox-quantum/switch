import { Bot, ExternalLink, MoreVertical, RotateCcw, Server, Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useConfirmDeleteAgent } from '@renderer/features/locations/hooks/use-confirm-delete-agent';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import {
  asMounted,
  getLocationStore,
  locationDisplayName,
  locationViewKind,
} from '@renderer/features/locations/stores/location-selectors';
import { ServerStatusPill } from '@renderer/features/switch-servers/server-presentation';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { OpenInMenu } from '@renderer/lib/components/titlebar/open-in-menu';
import { Titlebar } from '@renderer/lib/components/titlebar/Titlebar';
import { TitlebarBreadcrumb } from '@renderer/lib/components/titlebar/titlebar-breadcrumb';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import type { Agent } from '@shared/core/agents/agents';

/**
 * The agent this page is about. Falls back to the location's own name while the
 * agent list is still loading, or when the route carries no agent name.
 */
const AgentCrumb = observer(function AgentCrumb({
  locationId,
  agent,
}: {
  locationId: string;
  agent: Agent | null;
}) {
  const label = agent?.name ?? locationDisplayName(getLocationStore(locationId)) ?? 'Agent';
  return (
    <TitlebarBreadcrumb
      crumbs={[
        {
          key: 'agent',
          icon: agent?.providerId ? (
            <AgentIcon id={agent.providerId} size={14} className="shrink-0" />
          ) : (
            <Bot className="size-3.5 shrink-0" />
          ),
          label,
        },
      ]}
    />
  );
});

/**
 * Read-only display of a remote agent's working directory within its SSH host.
 * The local titlebar surfaces the path via the "Open in" menu, but that menu is
 * hidden for remote agents — so their location within the host would otherwise
 * not be shown anywhere. The full `host:dir` is available in the tooltip.
 */
function RemoteLocationPath({ host, dir }: { host: string; dir: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div className="flex h-7 max-w-[280px] items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs text-foreground-muted">
            <Server className="size-3.5 shrink-0" />
            <span className="shrink-0">{host}</span>
            <span className="truncate text-foreground-tertiary-passive">{dir}</span>
          </div>
        }
      />
      <TooltipContent side="bottom">
        {host}:{dir}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The agent's own actions, in the same order and wording the Your Agents table
 * offers them — the two places act on the same agent, so they must not read as
 * two different sets of powers.
 */
const AgentActionsMenu = observer(function AgentActionsMenu({
  locationId,
  agent,
  sshHost,
}: {
  locationId: string;
  agent: Agent | null;
  sshHost: string | null;
}) {
  const { navigate } = useNavigate();
  const showConfirmReset = useShowModal('resetAgentModal');
  const confirmDeleteAgent = useConfirmDeleteAgent();
  const { toastPromise } = useToast();

  const label = agent?.name ?? locationDisplayName(getLocationStore(locationId)) ?? 'this agent';
  const gatewayUrl =
    agent?.serverId && agent.switchAgentId
      ? switchRoomsStore.gatewayAgentUrl(agent.serverId, agent.switchAgentId)
      : null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="sm" className="size-7 p-0" aria-label={`${label} actions`}>
            <MoreVertical className="size-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        {gatewayUrl && agent?.serverId && (
          <DropdownMenuItem
            onClick={() =>
              void rpc.switchServers.openGatewayPage({ serverId: agent.serverId!, url: gatewayUrl })
            }
          >
            <ExternalLink className="size-4" />
            Open in gateway
          </DropdownMenuItem>
        )}
        {sshHost !== null && agent && (
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
              locationId,
              agentId: agent?.id,
              locationLabel: label,
              onDeleted: () => navigate('home'),
            });
          }}
        >
          <Trash2 className="size-4" />
          Remove agent…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

export const LocationTitlebar = observer(function LocationTitlebar() {
  const {
    params: { locationId, agentName },
  } = useParams('location');
  const store = getLocationStore(locationId);
  const agent = agentsStore.agentAtLocation(locationId, agentName);
  const server = agent?.serverId
    ? (switchServersStore.servers.find((s) => s.id === agent.serverId) ?? null)
    : null;

  const mounted = locationViewKind(store) === 'ready' ? asMounted(store) : undefined;

  return (
    <Titlebar
      leftSlot={<AgentCrumb locationId={locationId} agent={agent} />}
      rightSlot={
        <div className="mr-1 flex items-center gap-1.5">
          {mounted &&
            (mounted.data.sshHost === null ? (
              <OpenInMenu path={mounted.data.dir} className="h-7 bg-background" />
            ) : (
              <RemoteLocationPath host={mounted.data.sshHost} dir={mounted.data.dir} />
            ))}
          {server && <ServerStatusPill server={server} />}
          <AgentActionsMenu
            locationId={locationId}
            agent={agent}
            sshHost={mounted?.data.sshHost ?? null}
          />
        </div>
      }
    />
  );
});
