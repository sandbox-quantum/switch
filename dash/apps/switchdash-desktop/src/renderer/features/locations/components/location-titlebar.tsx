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
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';

const MountedLocationTitlebarLeft = observer(function LocationTitlebarLeft({
  locationId,
}: {
  locationId: string;
}) {
  const { navigate } = useNavigate();
  const store = getLocationStore(locationId);
  const displayName = locationDisplayName(store) ?? 'this location';
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
}: {
  locationId: string;
}) {
  const store = getLocationStore(locationId);
  const displayName = locationDisplayName(store);
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
    params: { locationId },
  } = useParams('location');
  const store = getLocationStore(locationId);
  const kind = locationViewKind(store);

  if (kind !== 'ready') {
    return <Titlebar leftSlot={<LocationTitlebarLeft locationId={locationId} />} />;
  }

  const mounted = asMounted(store);
  if (!mounted) return <Titlebar leftSlot={<LocationTitlebarLeft locationId={locationId} />} />;

  return (
    <Titlebar
      leftSlot={<MountedLocationTitlebarLeft locationId={locationId} />}
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
