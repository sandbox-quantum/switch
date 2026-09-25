import { managedServerHostBlocked } from '@main/core/managed-switch-server/managed-server-status';
import { HostUnreachableError } from '@shared/core/remote-hosts/reachability';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { getServer } from './servers-store';

export async function requireServer(serverId: string): Promise<SwitchServer> {
  const server = await getServer(serverId);
  if (!server) {
    throw new Error(`No Switch server with id ${serverId}`);
  }
  return server;
}

/**
 * The refusal a managed server's host being down produces, or null while it is
 * up.
 *
 * Returned rather than thrown so a path that reports its own outcome can count
 * the refusal before it propagates: the server is what an event describes
 * itself with, and a helper that throws leaves the caller holding nothing.
 */
export function hostUnreachable(server: SwitchServer): HostUnreachableError | null {
  const blocked = managedServerHostBlocked(server);
  return blocked ? new HostUnreachableError(blocked) : null;
}

/**
 * Resolve a server and refuse to touch its gateway while the host it is managed
 * on is unreachable (CHOO-1780). `gatewayFetch` enforces the same rule at the
 * transport, so this is for the paths that reach the gateway some other way —
 * sign-in and the dashboard window — and for failing before the side effects a
 * write would otherwise start.
 */
export async function requireReachableServer(serverId: string): Promise<SwitchServer> {
  const server = await requireServer(serverId);
  const unreachable = hostUnreachable(server);
  if (unreachable) throw unreachable;
  return server;
}
