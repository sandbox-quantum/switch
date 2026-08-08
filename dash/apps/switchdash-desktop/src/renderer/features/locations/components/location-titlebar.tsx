import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Ellipsis, Server, Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useConfirmDeleteAgent } from '@renderer/features/locations/hooks/use-confirm-delete-agent';
import {
  asMounted,
  getLocationStore,
  locationDisplayName,
  locationViewKind,
} from '@renderer/features/locations/stores/location-selectors';
import { OpenInMenu } from '@renderer/lib/components/titlebar/open-in-menu';
import { Titlebar } from '@renderer/lib/components/titlebar/Titlebar';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';

/**
 * The name of the agent this view is showing.
 *
 * The header used to show the *location* name, which defaults to the working
 * directory's basename — so a page about an agent was titled with the folder it
 * happens to live in, and a location holding several agents titled all of them
 * identically.
 *
 * `agentName` comes from the nav params the sidebar sets when opening an agent.
 * It is optional (the session titlebar navigates without it, as do snapshots
 * from older builds), so an absent one falls back to the location's first agent
 * — the same resolution the settings panels use.
 */
function useAgentDisplayName(
  locationId: string,
  agentName: string | undefined
): string | undefined {
  const { data: agents } = useQuery({
    queryKey: ['location-agents', locationId],
    queryFn: () => rpc.agents.getAgents(locationId),
  });
  const agent = agentName ? (agents ?? []).find((a) => a.name === agentName) : (agents ?? [])[0];
  return agent?.name ?? agentName;
}

const MountedLocationTitlebarLeft = observer(function LocationTitlebarLeft({
  locationId,
  agentName,
}: {
  locationId: string;
  agentName: string | undefined;
}) {
  const { navigate } = useNavigate();
  const store = getLocationStore(locationId);
  // The location name is the last resort, not the default: it is right only
  // when the agents have not loaded yet.
  const displayName =
    useAgentDisplayName(locationId, agentName) ?? locationDisplayName(store) ?? 'this location';
  const confirmDeleteAgent = useConfirmDeleteAgent();

  return (
    <div className="flex h-full items-center gap-2 px-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button className="group flex items-center gap-1.5 text-sm text-foreground-muted hover:text-foreground">
              <span className="text-sm">{displayName}</span>
              <ChevronDown className="size-3.5" />
            </button>
          }
        >
          <Ellipsis className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="min-w-40">
          <DropdownMenuItem
            className="flex items-center gap-2 text-foreground-destructive"
            onClick={() => {
              void confirmDeleteAgent({
                locationId,
                locationLabel: displayName,
                onDeleted: () => navigate('home'),
              });
            }}
          >
            <Trash2 className="size-4" />
            Remove Agent
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
});

const LocationTitlebarLeft = observer(function LocationTitlebarLeft({
  locationId,
  agentName,
}: {
  locationId: string;
  agentName: string | undefined;
}) {
  const store = getLocationStore(locationId);
  const displayName = useAgentDisplayName(locationId, agentName) ?? locationDisplayName(store);
  return (
    <div className="flex items-center gap-2 px-2">
      <span className="text-sm text-foreground-muted">{displayName}</span>
    </div>
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

export const LocationTitlebar = observer(function LocationTitlebar() {
  const {
    params: { locationId, agentName },
  } = useParams('location');
  const store = getLocationStore(locationId);
  const kind = locationViewKind(store);

  if (kind !== 'ready') {
    return (
      <Titlebar leftSlot={<LocationTitlebarLeft locationId={locationId} agentName={agentName} />} />
    );
  }

  const mounted = asMounted(store);
  if (!mounted) {
    return (
      <Titlebar leftSlot={<LocationTitlebarLeft locationId={locationId} agentName={agentName} />} />
    );
  }

  return (
    <Titlebar
      leftSlot={<MountedLocationTitlebarLeft locationId={locationId} agentName={agentName} />}
      rightSlot={
        <div className="mr-2 flex items-center gap-2">
          {mounted.data.sshHost === null ? (
            <OpenInMenu path={mounted.data.dir} className="h-7 bg-background" />
          ) : (
            <RemoteLocationPath host={mounted.data.sshHost} dir={mounted.data.dir} />
          )}
        </div>
      }
    />
  );
});
