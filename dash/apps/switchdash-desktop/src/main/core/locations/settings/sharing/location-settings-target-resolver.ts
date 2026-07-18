import { eq } from 'drizzle-orm';
import type { FileSystemProvider } from '@main/core/fs/types';
import { db } from '@main/db/client';
import { locations as locationsTable } from '@main/db/schema';
import type {
  LocationSettingsWriteTarget,
  LocationSettingsWriteTargetOption,
  WriteLocationConfigRequest,
} from '@shared/core/location-settings/location-settings';
import type { LocationProvider } from '../../location-provider';
import { resolveLocationRuntime } from '../../utils';

export type LocationSettingsResolvedTarget = LocationSettingsWriteTargetOption & {
  fs: FileSystemProvider;
};

function stripTarget(target: LocationSettingsWriteTargetOption): LocationSettingsWriteTarget {
  if (target.type === 'location') return { type: 'location' };
  if (target.type === 'session') return { type: 'session', sessionId: target.sessionId };
  return { type: 'workspace', locationId: target.locationId };
}

export function stripResolvedTarget(
  target: LocationSettingsResolvedTarget
): LocationSettingsWriteTargetOption {
  const { fs: _fs, ...option } = target;
  return option;
}

function targetKey(target: LocationSettingsWriteTarget): string {
  if (target.type === 'location') return 'location';
  if (target.type === 'session') return `session:${target.sessionId}`;
  return `workspace:${target.locationId}`;
}

export async function resolveAllLocationSettingsTargets(
  location: LocationProvider
): Promise<LocationSettingsResolvedTarget[]> {
  const [locationRow] = await db
    .select({ name: locationsTable.name })
    .from(locationsTable)
    .where(eq(locationsTable.id, location.locationId))
    .limit(1);

  const locationTarget: LocationSettingsResolvedTarget = {
    type: 'location',
    label: locationRow?.name ?? 'Location repository',
    path: location.dir,
    fs: location.fs,
  };
  // Every switchdash session runs in the location root, so there are no
  // session-scoped settings targets distinct from the location target.
  return [locationTarget];
}

export function getLocationSettingsWriteTargets(
  targets: LocationSettingsResolvedTarget[]
): LocationSettingsWriteTargetOption[] {
  return targets.map(stripResolvedTarget);
}

export async function resolveLocationSettingsTarget(
  location: LocationProvider,
  request: Pick<WriteLocationConfigRequest, 'target'>,
  resolvedTargets: LocationSettingsResolvedTarget[]
): Promise<LocationSettingsResolvedTarget | null> {
  const target = resolvedTargets.find(
    (candidate) => targetKey(stripTarget(candidate)) === targetKey(request.target)
  );
  if (target) return target;

  if (request.target.type === 'workspace') {
    const workspace = resolveLocationRuntime(request.target.locationId);
    return workspace
      ? {
          type: 'workspace',
          locationId: request.target.locationId,
          label: 'Workspace',
          path: workspace.path,
          fs: workspace.fs,
        }
      : null;
  }

  return null;
}
