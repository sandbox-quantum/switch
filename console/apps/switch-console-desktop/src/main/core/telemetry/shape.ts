import { getLocationById } from '@main/core/locations/store';
import type { TelemetryLocationKind } from './events';

/**
 * Where a location runs.
 *
 * `unknown` is reported rather than guessed when the row has gone — a wrong
 * answer here is indistinguishable from a real one. Reads the database, which is
 * why the pure provider-id helper lives in `./agent-type` rather than here.
 */
export async function locationKindOf(locationId: string): Promise<TelemetryLocationKind> {
  const location = await getLocationById(locationId);
  if (!location) return 'unknown';
  return location.sshHost ? 'remote' : 'local';
}
