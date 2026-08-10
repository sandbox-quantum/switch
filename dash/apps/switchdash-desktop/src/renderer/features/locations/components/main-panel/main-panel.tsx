import { Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useConfirmDeleteAgent } from '@renderer/features/locations/hooks/use-confirm-delete-agent';
import { hostReachabilityStore } from '@renderer/features/remote-hosts/host-reachability-store';
import { HostUnreachablePanel } from '@renderer/features/remote-hosts/host-unreachable-panel';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { isUnregisteredLocation } from '../../stores/location';
import {
  getLocationManagerStore,
  getLocationStore,
  locationDisplayName,
  locationViewKind,
  unmountedMountErrorMessage,
} from '../../stores/location-selectors';
import { ActiveLocation } from './active-location';
import { PendingLocationStatus } from './pending-location';

export const LocationMainPanel = observer(function LocationMainPanel() {
  const {
    params: { locationId },
  } = useParams('location');
  const store = getLocationStore(locationId);
  const kind = locationViewKind(store);
  const displayName = locationDisplayName(store) ?? 'this location';

  if (kind === 'creating' && store && isUnregisteredLocation(store)) {
    return <PendingLocationStatus location={store} />;
  }

  // A blocked host outranks every other view state, mounted included (CHOO-1682).
  // A location that mounted before its host went down is still backed by nothing:
  // its sessions, settings writes and sidecar controls all ride the SSH transport,
  // so leaving the tabs up offers actions that can only fail. The panel names the
  // cause instead, and the pane comes back on its own when the host does.
  const sshHost = store?.data?.sshHost ?? null;
  if (sshHost && hostReachabilityStore.isBlocked(sshHost)) {
    return <HostUnreachablePanel reachability={hostReachabilityStore.get(sshHost)} />;
  }

  if (kind === 'bootstrapping') {
    return <LocationBootstrappingPanel />;
  }

  if (kind === 'path_not_found') {
    return (
      <LocationPathNotFoundPanel
        path={store?.error ?? ''}
        locationId={locationId}
        title={displayName}
      />
    );
  }

  if (kind === 'mount_error') {
    return (
      <LocationBootstrapErrorPanel
        locationId={locationId}
        message={unmountedMountErrorMessage(store)}
      />
    );
  }

  if (kind !== 'ready') {
    return <div className="flex flex-1 items-center justify-center text-foreground-muted" />;
  }

  return <ActiveLocation />;
});

function LocationBootstrappingPanel() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3">
      <Loader2 className="h-5 w-5 animate-spin text-foreground-passive" />
      <p className="font-mono text-xs text-foreground-passive">Setting up location…</p>
    </div>
  );
}

function LocationBootstrapErrorPanel({
  locationId,
  message,
}: {
  locationId: string;
  message: string;
}) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center p-8">
      <div className="flex max-w-xs flex-col items-center gap-3 text-center">
        <TriangleAlert className="h-6 w-6 text-foreground-destructive" />
        <p className="font-mono text-sm font-medium text-foreground-destructive">
          Failed to set up location
        </p>
        <p className="font-mono text-xs text-foreground-passive">{message}</p>
        <button
          type="button"
          className="mt-1 inline-flex items-center gap-1.5 text-xs text-foreground-muted underline underline-offset-2 transition-colors hover:text-foreground"
          onClick={() => {
            void getLocationManagerStore().mountLocation(locationId);
          }}
        >
          <RefreshCw className="h-3 w-3" />
          Retry connection
        </button>
      </div>
    </div>
  );
}

function LocationPathNotFoundPanel({
  path,
  locationId,
  title,
}: {
  path: string;
  locationId: string;
  title: string;
}) {
  const confirmDeleteAgent = useConfirmDeleteAgent();

  return (
    <div className="flex h-full w-full flex-col items-center justify-center p-8">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <TriangleAlert className="h-6 w-6 text-foreground-destructive" />
        <p className="font-mono text-sm font-medium text-foreground-destructive">
          Location not found
        </p>
        {path && <p className="font-mono text-xs break-all text-foreground-passive">{path}</p>}
        <p className="text-xs text-foreground-passive">
          The location directory no longer exists at the configured path.
        </p>
        <button
          type="button"
          className="mt-2 text-xs text-foreground-destructive underline underline-offset-2 transition-colors hover:text-foreground-destructive/80"
          onClick={() => {
            void confirmDeleteAgent({ locationId, locationLabel: title });
          }}
        >
          Remove Location
        </button>
      </div>
    </div>
  );
}
