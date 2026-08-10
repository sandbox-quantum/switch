import { managedServerStateDir } from '@main/core/managed-switch-server/host/host-for-server';
import { readPersistedPorts } from '@main/core/managed-switch-server/ports';
import { getServer } from '@main/core/switch-servers/servers-store';

/**
 * Where this server's Mattermost is reachable from the desktop, or null when we
 * don't run it. Only managed servers publish Mattermost on a port we chose and
 * hold credentials for; an external server's Mattermost (if any) is somebody
 * else's deployment.
 */
export async function mattermostOriginFor(serverId: string): Promise<string | null> {
  const server = await getServer(serverId);
  if (!server?.managed) return null;

  const ports = await readPersistedPorts({ stateDir: managedServerStateDir(server) });
  if (!ports) return null;

  // Remote-managed stacks publish onto the SSH host's loopback and are reached
  // through the same forwarded ports the gateway URL already uses, so the
  // gateway's hostname is the right one to pair with the Mattermost port.
  const gatewayHost = new URL(server.gatewayUrl).hostname;
  return `http://${gatewayHost}:${ports.mattermost}`;
}
