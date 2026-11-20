import type { GuardResult } from '@renderer/app/view-registry';
import { appState } from '@renderer/lib/stores/app-state';
import { switchServersStore } from './switch-servers-store';

/**
 * The server whose Home is the app's home: the active workspace's, else the
 * first server listed, else none.
 *
 * Only a server still in the list counts. The server view sends an id that
 * names no server here, so answering with one would send it straight back.
 */
export function homeServerId(): string | null {
  const { servers, activeServerId } = switchServersStore;
  if (activeServerId !== null && servers.some((server) => server.id === activeServerId)) {
    return activeServerId;
  }
  return servers[0]?.id ?? null;
}

/** A guard's way out to the home: the active workspace's Home, or the no-server page. */
export function homeRedirect(): GuardResult & { ok: false } {
  const serverId = homeServerId();
  return serverId === null
    ? { ok: false, redirect: 'noServer' }
    : { ok: false, redirect: 'server', params: { serverId } };
}

/** Go to the active workspace's Home, or to the no-server page when there is no server. */
export function navigateHome(): void {
  const serverId = homeServerId();
  if (serverId === null) appState.navigation.navigate('noServer');
  else appState.navigation.navigate('server', { serverId });
}
