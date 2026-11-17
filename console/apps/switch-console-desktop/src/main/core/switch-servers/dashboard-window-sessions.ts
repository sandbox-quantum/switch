import { session as electronSession } from 'electron';
import { log } from '@main/lib/logger';
import {
  dashboardWindowSessionsCleared,
  markDashboardWindowSessionsCleared,
} from './dashboard-window-marker';
import { listServers } from './servers-store';

/** The partition each server's in-app dashboard window used to load in. */
export function dashboardWindowPartition(serverId: string): string {
  return `persist:switch-gateway:${serverId}`;
}

/**
 * Clear what the old in-app dashboard windows kept, once per install.
 *
 * Each server's window had its own persistent partition holding a copy of
 * Console's session cookie for that server. Dashboard pages open in the
 * browser now, with a session of the browser's own, so those copies are
 * only a credential lying on disk. A server whose partition cannot be
 * cleared is logged, and the whole pass runs again at the next launch.
 */
export async function clearDashboardWindowSessions(): Promise<void> {
  if (await dashboardWindowSessionsCleared()) return;
  const servers = await listServers();
  const results = await Promise.allSettled(
    servers.map(async (server) =>
      electronSession.fromPartition(dashboardWindowPartition(server.id)).clearStorageData()
    )
  );
  const failed = results.flatMap((result, index) =>
    result.status === 'rejected' ? [{ server: servers[index]?.id, reason: result.reason }] : []
  );
  for (const { server, reason } of failed) {
    log.warn('switch-servers: could not clear the session an old dashboard window kept', {
      server,
      error: String(reason),
    });
  }
  if (failed.length === 0) await markDashboardWindowSessionsCleared();
}
