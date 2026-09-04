import type { SidecarRunStatus } from '@main/core/agent-runtime/impl/remote-sidecar-launcher';
import type { SidecarVerdict } from '@shared/events/sidecarEvents';
import { compareSidecarVersions, isMajorUpgrade } from '../../../sidecar/sidecar-version';

/** What this client ships, and who it is — the other half of the comparison. */
export interface SidecarClientBuild {
  hash: string;
  version: string;
  /** This install's deployer identity (see `deployer-identity.ts`). */
  deployerId: string;
}

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
 *
 * The same is true one step further down, where version ordering has run out:
 * a same-version build another install deployed is not an upgrade either, and
 * offering one is how two dev builds trade the sidecar back and forth. Must stay
 * in step with `decideExisting` in the launcher — a verdict the deploy policy
 * disagrees with is an Update button that silently does nothing.
 */
export function verdictFor(status: SidecarRunStatus, client: SidecarClientBuild): SidecarVerdict {
  if (!status.running) return 'not-running';
  if (!status.compatible) return 'incompatible';
  if (status.hash === client.hash) return 'up-to-date';
  const order = compareSidecarVersions(status.version, client.version);
  if (order > 0) return 'newer-on-host';
  if (order === 0 && status.deployerId !== null && status.deployerId !== client.deployerId) {
    return 'other-install';
  }
  // Live sessions no longer hold an upgrade back on their own — the launcher
  // takes one through a restart, which costs a few seconds of room injection.
  // Only a major bump waits for an idle sidecar, because that is where the
  // durable state schema may move.
  if (status.liveSessions > 0 && isMajorUpgrade(status.version, client.version)) {
    return 'upgrade-pending';
  }
  return 'upgrade-available';
}
