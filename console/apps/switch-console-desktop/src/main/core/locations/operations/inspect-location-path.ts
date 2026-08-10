import { detectSwitchAgent } from '@main/core/agents/detect';
import type {
  InspectLocationPathParams,
  LocationPathInspection,
} from '@shared/core/locations/locations';
import { checkIsValidDirectory } from '../path-utils';
import { getLocationByHostDir } from '../store';

export async function inspectLocationPath(
  params: InspectLocationPathParams
): Promise<LocationPathInspection> {
  const [existingLocation, switchAgent] = await Promise.all([
    getLocationByHostDir(null, params.path),
    detectSwitchAgent(params.path),
  ]);

  return {
    isDirectory: checkIsValidDirectory(params.path),
    existingLocation,
    switchAgent,
  };
}
