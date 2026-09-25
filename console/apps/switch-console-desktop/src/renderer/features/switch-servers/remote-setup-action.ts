import type { RemoteStackProbe } from '@shared/core/managed-switch-server/managed-switch-server';

/**
 * What the remote setup step offers for a host, from what the host was found
 * to have (CHOO-2893). A host is shared by everyone with access to it, so the
 * step never assumes it is empty: it looks first, then offers the one action
 * that is safe there.
 */
export type RemoteSetupAction =
  /** Not looked at yet, or being looked at. */
  | { kind: 'checking' }
  /** A running stack this account can read: join it, touching nothing — or,
   * when `updatesTo` is set, bring it up to this build's switch-core first,
   * since this Console cannot use it as it is. That update is for everyone
   * using it. */
  | {
      kind: 'connect';
      deployedVersion: string | null;
      shared: boolean;
      updatesTo: string | null;
    }
  /** Start a stack — `existing` when one is set up but stopped, whose data and
   * credentials the start keeps; otherwise a new one. */
  | { kind: 'start'; existing: boolean }
  /** Nothing is safe to do from this account; the reason is for the user. */
  | { kind: 'blocked'; title: string; detail: string }
  /** Docker is not usable on the host; the Docker notice says why. */
  | { kind: 'docker' };

export function remoteSetupAction(
  hostLabel: string,
  probe: RemoteStackProbe | null,
  probing: boolean
): RemoteSetupAction {
  if (probing || probe === null) return { kind: 'checking' };
  switch (probe.kind) {
    case 'absent':
      return { kind: 'start', existing: false };
    case 'present':
      if (!probe.running) return { kind: 'start', existing: true };
      if (probe.drift?.direction === 'downgrade') {
        return {
          kind: 'blocked',
          title: `The server on ${hostLabel} is newer than this Console`,
          detail:
            `It runs switch-core ${probe.drift.deployed}, and this Console runs ` +
            `${probe.drift.expected}, so it cannot use it. Update Switch Console, then connect.`,
        };
      }
      return {
        kind: 'connect',
        deployedVersion: probe.deployedVersion,
        shared: probe.shared,
        updatesTo: probe.drift?.direction === 'upgrade' ? probe.drift.expected : null,
      };
    case 'unshared':
      return {
        kind: 'blocked',
        title: `The server on ${hostLabel} belongs to another account`,
        detail: probe.message,
      };
    case 'incomplete':
      return {
        kind: 'blocked',
        title: `The server on ${hostLabel} cannot be read`,
        detail:
          `Its settings are missing ${probe.missing.join(', ')}. Starting it from here could ` +
          `replace the credentials its data was created with, so it is not offered.`,
      };
    case 'unreadable':
      return {
        kind: 'blocked',
        title: `Could not check ${hostLabel} for a Switch server`,
        detail: probe.reason,
      };
    case 'docker-unavailable':
      return { kind: 'docker' };
  }
}
