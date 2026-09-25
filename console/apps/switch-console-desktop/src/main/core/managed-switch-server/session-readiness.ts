import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { localServerService } from './local-server-service';
import { remoteServerService } from './remote-server-service';

/**
 * The one gate between a managed Switch server and anything that runs agents
 * against it — a session starting, or an agent's room watcher connecting.
 *
 * Resolves at once for a server Console only connects to, and for a managed
 * one that is in step with this build. For a managed server Console is still
 * checking or upgrading it waits until that has finished; for one that owes an
 * upgrade it cannot run now (stopped, or a failed update) it throws the reason.
 */
export async function ensureServerSessionReady(server: SwitchServer): Promise<void> {
  if (!server.managed) return;
  if (server.managementKind === 'remote') {
    // A remote row without a host is not one Console can supervise.
    if (server.sshHost === null) return;
    await remoteServerService.ensureReady(server.sshHost, server.name);
    return;
  }
  await localServerService.ensureReady(server.name);
}

/**
 * Called with a managed server's id when an upgrade that held its sessions
 * back has finished, so whatever was refused can be started again.
 */
export function onManagedServerUpgraded(listener: (serverId: string) => void): void {
  localServerService.onUpgradeFinished(listener);
  remoteServerService.onUpgradeFinished(listener);
}
