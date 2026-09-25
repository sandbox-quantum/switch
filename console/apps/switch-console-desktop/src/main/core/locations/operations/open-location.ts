import { err, ok, type Result } from '@switch-console/shared';
import { locationManager } from '@main/core/locations/location-manager';
import type { OpenLocationError } from '@shared/core/locations/locations';
import { checkIsValidDirectory } from '../path-utils';
import { getLocationById } from '../store';

export async function openLocation(locationId: string): Promise<Result<void, OpenLocationError>> {
  const location = await getLocationById(locationId);
  if (!location) return err({ type: 'error', message: `Location not found: ${locationId}` });
  // Remote locations have no local path — their working dir lives on the host,
  // so there is nothing to validate here; provisioning handles the remote.
  if (location.sshHost === null && !checkIsValidDirectory(location.dir)) {
    return err({ type: 'path-not-found', path: location.dir });
  }
  const result = await locationManager.openLocation(location);
  if (!result.success) {
    return err({ type: 'error', message: result.error.message });
  }

  return ok();
}
