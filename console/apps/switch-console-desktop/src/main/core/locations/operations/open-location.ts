import { err, ok, type Result } from '@switch-console/shared';
import { locationManager } from '@main/core/locations/location-manager';
import type { OpenLocationError } from '@shared/core/locations/locations';
import { checkIsValidDirectory } from '../path-utils';
import { getLocationById } from '../store';

export async function openLocation(locationId: string): Promise<Result<void, OpenLocationError>> {
  const location = await getLocationById(locationId);
  if (!location) return err({ type: 'error', message: `Location not found: ${locationId}` });
  // An observed location is followed through its server alone (CHOO-2893):
  // nothing on the host is this Console's to open, so it opens without a
  // provider, and anything that would need one refuses for it.
  if (location.observed) return ok();
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
