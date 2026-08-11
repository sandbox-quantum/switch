import type { SidecarRunStatus } from '@main/core/agent-runtime/impl/remote-sidecar-launcher';
import type { SidecarVerdict } from '@shared/events/sidecarEvents';
import { compareSidecarVersions } from '../../../sidecar/sidecar-version';

/**
 * Turn a raw host status + this client's build into the client-vs-host verdict.
 *
 * Compatibility (can I talk to it) is checked before the build comparison (is an
 * upgrade available), mirroring the launcher's deploy policy — a build that
 * differs is not a problem, only a protocol that does not fit is.
 *
 * A running sidecar newer than this client is reported as such rather than as an
 * upgrade, matching what the launcher will actually do with it. Offering
 * "Update" there would invite a downgrade, and on a host two installs share it
 * is an invitation each of them accepts in turn (CHOO-1937).
 */
export function verdictFor(
  status: SidecarRunStatus,
  clientHash: string,
  clientVersion: string
): SidecarVerdict {
  if (!status.running) return 'not-running';
  if (!status.compatible) return 'incompatible';
  if (status.hash === clientHash) return 'up-to-date';
  if (compareSidecarVersions(status.version, clientVersion) > 0) return 'newer-on-host';
  return status.liveSessions > 0 ? 'upgrade-pending' : 'upgrade-available';
}
