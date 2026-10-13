import type { ServerLockHolder } from '@shared/core/managed-switch-server/managed-switch-server';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { localServerStore } from './local-server-store';
import { remoteServerStore } from './remote-server-store';

/**
 * A managed server's lifecycle, the same calls whichever store runs it. Kept in
 * one place so the banner, the switcher and the server page cannot start a
 * server two different ways.
 */

function remoteHost(server: SwitchServer): string | null {
  return server.managementKind === 'remote' ? server.sshHost : null;
}

/** Start the server, or restart it: re-running the start is also what applies
 * an update. */
export function startManagedServer(server: SwitchServer): void {
  const host = remoteHost(server);
  if (host) {
    void remoteServerStore.start(host, server.name);
    return;
  }
  void localServerStore.start();
}

export function stopManagedServer(server: SwitchServer): void {
  const host = remoteHost(server);
  if (host) {
    void remoteServerStore.stop(host);
    return;
  }
  void localServerStore.stop();
}

/** What the server is doing right now ("Pulling images…"), or null. */
export function managedServerProgress(server: SwitchServer): string | null {
  const host = remoteHost(server);
  return host ? remoteServerStore.statusFor(host).message : localServerStore.message;
}

/** Why its last start failed, as the main process reported it, or null. */
export function managedServerError(server: SwitchServer): string | null {
  const host = remoteHost(server);
  const status = host ? remoteServerStore.statusFor(host) : localServerStore.status;
  return status?.error ?? null;
}

/** The output of the last start this window saw. */
export function managedServerLogs(server: SwitchServer): string[] {
  const host = remoteHost(server);
  return host ? remoteServerStore.logsFor(host) : localServerStore.logs;
}

/** The other Console this one is waiting on, or null. */
export function managedServerWaitingFor(server: SwitchServer): ServerLockHolder | null {
  const host = remoteHost(server);
  return host ? remoteServerStore.statusFor(host).waitingFor : null;
}
