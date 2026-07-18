import { ChevronDown, Ellipsis, Trash2 } from 'lucide-react';
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

const MountedProjectTitlebarLeft = observer(function ProjectTitlebarLeft({
  locationId,
}: {
  locationId: string;
}) {
  const { navigate } = useNavigate();
  const store = getLocationStore(locationId);
  const displayName = locationDisplayName(store) ?? 'this project';
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
                projectLabel: displayName,
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

const ProjectTitlebarLeft = observer(function ProjectTitlebarLeft({
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

export const LocationTitlebar = observer(function LocationTitlebar() {
  const {
    params: { locationId },
  } = useParams('location');
  const store = getLocationStore(locationId);
  const kind = locationViewKind(store);

  if (kind !== 'ready') {
    return <Titlebar leftSlot={<ProjectTitlebarLeft locationId={locationId} />} />;
  }

  const mounted = asMounted(store);
  if (!mounted) return <Titlebar leftSlot={<ProjectTitlebarLeft locationId={locationId} />} />;

  return (
    <Titlebar
      leftSlot={<MountedProjectTitlebarLeft locationId={locationId} />}
      rightSlot={
        <div className="mr-2 flex items-center gap-2">
          {mounted.data.sshHost === null && (
            <OpenInMenu path={mounted.data.dir} className="h-7 bg-background" />
          )}
        </div>
      }
    />
  );
});
