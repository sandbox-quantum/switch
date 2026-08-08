import type {
  InspectLocationPathParams,
  LocationPathInspection,
} from '@shared/core/locations/locations';
import { checkIsValidDirectory } from '../path-utils';
import { getLocationByHostDir } from '../store';

export async function inspectLocationPath(
  params: InspectLocationPathParams
): Promise<LocationPathInspection> {
  return {
    isDirectory: checkIsValidDirectory(params.path),
    existingLocation: await getLocationByHostDir(null, params.path),
  };
}
