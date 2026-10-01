import {
  deleteBridge,
  deleteMessagingAppInstall,
  fetchMessagingAppInstalls,
  GatewayError,
} from '@main/core/switch-servers/gateway-client';
import type { DeleteBridgeResult, SwitchServer } from '@shared/core/switch-servers/switch-servers';

/**
 * Disconnect a bridge, going through whichever endpoint the gateway actually
 * accepts for it.
 *
 * A bridge created by installing Switch's own app refuses plain
 * `DELETE /collaborations/{id}` with 409 while its install is live: ending the
 * install is what tells the platform and releases the workspace, and it
 * removes the bridge as part of that. So this finds the active install naming
 * this bridge and ends it through `DELETE /messaging-apps/installs/{id}`; a
 * bridge with no such install (every bridge registered with pasted-in
 * credentials) is deleted the ordinary way.
 *
 * The installs list is read with the same 404-tolerance as everywhere else a
 * server might predate a route: an older server has no installs to find, so
 * this falls back to the ordinary delete rather than failing.
 */
export async function disconnectBridgeOnServer(
  server: SwitchServer,
  bridgeId: string
): Promise<DeleteBridgeResult> {
  const installs = await fetchMessagingAppInstalls(server);
  const active = installs.find((i) => i.bridgeId === bridgeId && i.endedAt === null);
  if (!active) {
    return deleteBridge(server, bridgeId);
  }
  try {
    await deleteMessagingAppInstall(server, active.id);
    return { kind: 'deleted' };
  } catch (cause) {
    if (cause instanceof GatewayError) {
      if (cause.kind === 'unauthorized') return { kind: 'unauthenticated' };
      if (cause.kind === 'http' && cause.status === 403) return { kind: 'forbidden' };
      if (cause.kind === 'http' && cause.status === 404) return { kind: 'not-found' };
      if (cause.kind === 'network') return { kind: 'error', message: cause.message };
    }
    throw cause;
  }
}
