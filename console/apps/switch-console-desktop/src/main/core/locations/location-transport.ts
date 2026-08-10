import type { Location } from '@shared/core/locations/locations';

/**
 * How a location's execution reaches its working directory: on this machine,
 * or over a pooled SSH connection to the location's host. Derived from the
 * location row — the runtime registry, runtime factory, and session providers
 * all key off this.
 */
export type LocationTransport =
  | { kind: 'local' }
  | { kind: 'ssh'; host: string; dir: string; connectionId: string };

export function locationTransport(location: Pick<Location, 'sshHost' | 'dir'>): LocationTransport {
  if (location.sshHost === null) return { kind: 'local' };
  return {
    kind: 'ssh',
    host: location.sshHost,
    dir: location.dir,
    connectionId: sshConnectionIdForHost(location.sshHost),
  };
}

/**
 * The pooled SSH connection id for a host. One connection per host, shared by
 * every remote session, sidecar deploy, and fs operation on that host.
 */
export function sshConnectionIdForHost(sshHost: string): string {
  return `agent-ssh:${sshHost}`;
}
