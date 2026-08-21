import { getLocationById } from '@main/core/locations/store';
import {
  isValidProviderId,
  type AgentProviderId,
} from '@shared/core/providers/agent-provider-registry';
import type { TelemetryLocationKind } from './events';

/**
 * The two dimensions almost every event carries, derived once.
 *
 * They live apart from the listeners because a failure has no hook to be
 * reported from and so is reported at its own call site — and both places must
 * answer these questions the same way, or the failure population is described
 * in different terms from the successes it should be compared against.
 */

/** A provider id straight from the database is typed, not validated. */
export function agentTypeOf(providerId: string): AgentProviderId | 'unknown' {
  return isValidProviderId(providerId) ? providerId : 'unknown';
}

/**
 * Where a location runs. `unknown` is reported rather than guessed when the row
 * has gone — a wrong answer here is indistinguishable from a real one.
 */
export async function locationKindOf(locationId: string): Promise<TelemetryLocationKind> {
  const location = await getLocationById(locationId);
  if (!location) return 'unknown';
  return location.sshHost ? 'remote' : 'local';
}
