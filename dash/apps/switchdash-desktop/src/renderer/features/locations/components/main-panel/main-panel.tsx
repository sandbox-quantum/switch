import { Loader2, TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useConfirmDeleteAgent } from '@renderer/features/locations/hooks/use-confirm-delete-agent';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { isUnregisteredLocation } from '../../stores/location';
import {
  getLocationStore,
  locationDisplayName,
  locationViewKind,
  unmountedMountErrorMessage,
} from '../../stores/location-selectors';
import { ActiveProject } from './active-location';
import { PendingProjectStatus } from './pending-location';

export const LocationMainPanel = observer(function LocationMainPanel() {
  const {
    params: { locationId },
  } = useParams('location');
  const store = getLocationStore(locationId);
  const kind = locationViewKind(store);
  const displayName = locationDisplayName(store) ?? 'this project';

  if (kind === 'creating' && store && isUnregisteredLocation(store)) {
    return <PendingProjectStatus project={store} />;
  }

  if (kind === 'bootstrapping') {
    return <ProjectBootstrappingPanel />;
  }

  if (kind === 'path_not_found') {
    return (
      <ProjectPathNotFoundPanel
        path={store?.error ?? ''}
        locationId={locationId}
        title={displayName}
      />
    );
  }

  if (kind === 'mount_error') {
    return <ProjectBootstrapErrorPanel message={unmountedMountErrorMessage(store)} />;
  }

  if (kind !== 'ready') {
    return <div className="flex flex-1 items-center justify-center text-foreground-muted" />;
  }

  return <ActiveProject />;
});

function ProjectBootstrappingPanel() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3">
      <Loader2 className="h-5 w-5 animate-spin text-foreground-passive" />
      <p className="font-mono text-xs text-foreground-passive">Setting up project…</p>
    </div>
  );
}

function ProjectBootstrapErrorPanel({ message }: { message: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center p-8">
      <div className="flex max-w-xs flex-col items-center gap-2 text-center">
        <p className="font-mono text-sm font-medium text-foreground-destructive">
          Failed to set up project
        </p>
        <p className="font-mono text-xs text-foreground-passive">{message}</p>
      </div>
    </div>
  );
}

function ProjectPathNotFoundPanel({
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
          Project not found
        </p>
        {path && <p className="font-mono text-xs break-all text-foreground-passive">{path}</p>}
        <p className="text-xs text-foreground-passive">
          The project directory no longer exists at the configured path.
        </p>
        <button
          type="button"
          className="mt-2 text-xs text-foreground-destructive underline underline-offset-2 transition-colors hover:text-foreground-destructive/80"
          onClick={() => {
            void confirmDeleteAgent({ locationId, projectLabel: title });
          }}
        >
          Remove Project
        </button>
      </div>
    </div>
  );
}
