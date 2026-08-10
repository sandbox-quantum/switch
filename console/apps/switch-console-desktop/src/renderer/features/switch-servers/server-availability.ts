import { localServerStore } from './local-server-store';
import { remoteServerStore } from './remote-server-store';
import { switchServersStore } from './switch-servers-store';

/**
 * Why a server's data is or is not available right now.
 *
 * - `available` — signed in; its rooms and agents can be read.
 * - `signed-out` — reachable but not signed in. Nothing can be read until the
 *   user signs in, so retrying is pointless; the fix is an action they take.
 * - `unreachable` — the gateway did not answer. A fault rather than a prompt:
 *   signing in is impossible while it is down, so offering it would be an
 *   action that cannot work.
 * - `dormant` — a managed stack that is not running. There is no gateway to
 *   sign in to yet, so this is not a sign-in prompt either.
 */
export type ServerAvailability = 'available' | 'signed-out' | 'unreachable' | 'dormant';

/**
 * A managed server that is not running has no gateway to reach, so it cannot be
 * signed into — it is dormant rather than signed out. Shared by the server rows
 * and anything that reports on a server's data being unavailable, so the two
 * cannot describe the same server differently.
 */
export function serverAvailability(serverId: string): ServerAvailability {
  const server = switchServersStore.servers.find((s) => s.id === serverId);
  if (!server) return 'signed-out';

  const managedRunning = !server.managed
    ? true
    : server.managementKind === 'remote' && server.sshHost
      ? remoteServerStore.isRunning(server.sshHost)
      : localServerStore.isRunning;
  if (server.managed && !managedRunning) return 'dormant';
  if (switchServersStore.isConnected(serverId)) return 'available';
  return switchServersStore.isUnreachable(serverId) ? 'unreachable' : 'signed-out';
}
