import type { StartLocalServerResult } from '@shared/core/managed-switch-server/managed-switch-server';
import type { TelemetryManagedServerAction, TelemetryManagedServerFailure } from './events';
import { trackEvent } from './telemetry-service';

/**
 * What starting, stopping or resetting a managed server reported.
 *
 * One place rather than six near-identical blocks across the local and remote
 * services, whose only real difference is which of the two they are.
 */

/** A start's own result union, as a reportable code. */
function startFailureReason(result: StartLocalServerResult): TelemetryManagedServerFailure {
  switch (result.kind) {
    case 'started':
      return 'none';
    case 'docker-unavailable':
      return result.reason === 'not-installed' ? 'docker_not_installed' : 'docker_daemon_down';
    case 'version-downgrade':
      return 'version_downgrade';
    case 'error':
      return 'error';
  }
}

/**
 * Report a start.
 *
 * Starting is the only one of the three that probes for Docker, so it is the
 * only one that can answer whether Docker was there — which is exactly the
 * question worth asking, since Docker missing or refusing is the wall most
 * first-run failures hit.
 */
export function reportManagedServerStart(
  target: 'local' | 'remote',
  result: StartLocalServerResult
): void {
  trackEvent('managed_server_action', {
    action: 'start',
    target,
    outcome: result.kind === 'started' ? 'success' : 'failure',
    failure_reason: startFailureReason(result),
    docker_available: result.kind === 'docker-unavailable' ? 'unavailable' : 'available',
  });
}

/**
 * Report a stop or a reset.
 *
 * Neither probes for Docker, so neither can say whether it was available, and
 * `unknown` is the honest answer rather than adding a round trip — on the remote
 * path, an SSH one — to a teardown that does not otherwise need it.
 *
 * Both signal failure by throwing, so there is no result union to read: the
 * caller reports which of the two happened.
 */
export function reportManagedServerOutcome(
  action: Exclude<TelemetryManagedServerAction, 'start'>,
  target: 'local' | 'remote',
  outcome: 'success' | 'failure'
): void {
  trackEvent('managed_server_action', {
    action,
    target,
    outcome,
    failure_reason: outcome === 'success' ? 'none' : 'error',
    docker_available: 'unknown',
  });
}
