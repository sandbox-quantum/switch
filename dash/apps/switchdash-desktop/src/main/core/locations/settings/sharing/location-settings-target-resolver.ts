import { eq } from 'drizzle-orm';
import type { FileSystemProvider } from '@main/core/fs/types';
import { db } from '@main/db/client';
import { locations as locationsTable } from '@main/db/schema';
import type {
  LocationSettingsWriteTarget,
  ProjectSettingsWriteTargetOption,
  WriteProjectConfigRequest,
} from '@shared/core/location-settings/location-settings';
import type { LocationProvider } from '../../location-provider';
import { resolveLocationRuntime } from '../../utils';

export type ProjectSettingsResolvedTarget = ProjectSettingsWriteTargetOption & {
  fs: FileSystemProvider;
};

function stripTarget(target: ProjectSettingsWriteTargetOption): LocationSettingsWriteTarget {
  if (target.type === 'project') return { type: 'project' };
  if (target.type === 'session') return { type: 'session', sessionId: target.sessionId };
  return { type: 'workspace', locationId: target.locationId };
}

export function stripResolvedTarget(
  target: ProjectSettingsResolvedTarget
): ProjectSettingsWriteTargetOption {
  const { fs: _fs, ...option } = target;
  return option;
}

function targetKey(target: LocationSettingsWriteTarget): string {
  if (target.type === 'project') return 'project';
  if (target.type === 'session') return `session:${target.sessionId}`;
  return `workspace:${target.locationId}`;
}

export async function resolveAllProjectSettingsTargets(
  project: LocationProvider
): Promise<ProjectSettingsResolvedTarget[]> {
  const [locationRow] = await db
    .select({ name: locationsTable.name })
    .from(locationsTable)
    .where(eq(locationsTable.id, project.locationId))
    .limit(1);

  const projectTarget: ProjectSettingsResolvedTarget = {
    type: 'project',
    label: locationRow?.name ?? 'Location repository',
    path: project.dir,
    fs: project.fs,
  };
  // Every switchdash session runs in the project root, so there are no
  // session-scoped settings targets distinct from the project target.
  return [projectTarget];
}

export function getProjectSettingsWriteTargets(
  targets: ProjectSettingsResolvedTarget[]
): ProjectSettingsWriteTargetOption[] {
  return targets.map(stripResolvedTarget);
}

export async function resolveProjectSettingsTarget(
  project: LocationProvider,
  request: Pick<WriteProjectConfigRequest, 'target'>,
  resolvedTargets: ProjectSettingsResolvedTarget[]
): Promise<ProjectSettingsResolvedTarget | null> {
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
