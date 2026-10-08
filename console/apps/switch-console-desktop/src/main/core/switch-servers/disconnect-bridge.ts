import {
  deleteBridge,
  deleteMessagingAppInstall,
  fetchMessagingAppInstalls,
  GatewayError,
} from '@main/core/switch-servers/gateway-client';
import type {
  BridgeInstallState,
  DeleteBridgeResult,
  SwitchServer,
} from '@shared/core/switch-servers/switch-servers';

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
  try {
    const active = await activeInstallFor(server, bridgeId);
    if (!active) {
      return await deleteBridge(server, bridgeId);
    }
    await deleteMessagingAppInstall(server, active.id);
    return { kind: 'deleted' };
  } catch (cause) {
    const result = resultFor(cause);
    if (result) return result;
    throw cause;
  }
}

/**
 * Whether a bridge is backed by a live install, which decides both how it is
 * disconnected and what disconnecting it does to its rooms: an install's end
 * keeps them as internal-only rooms, a bridge delete removes them.
 */
export async function bridgeInstallState(
  server: SwitchServer,
  bridgeId: string
): Promise<BridgeInstallState> {
  try {
    return (await activeInstallFor(server, bridgeId)) ? 'installed' : 'not-installed';
  } catch (cause) {
    if (resultFor(cause)) return 'unknown';
    throw cause;
  }
}

async function activeInstallFor(server: SwitchServer, bridgeId: string) {
  const installs = await fetchMessagingAppInstalls(server);
  return installs.find((i) => i.bridgeId === bridgeId && i.endedAt === null) ?? null;
}

function resultFor(cause: unknown): DeleteBridgeResult | null {
  if (!(cause instanceof GatewayError)) return null;
  if (cause.kind === 'unauthorized') return { kind: 'unauthenticated' };
  if (cause.kind === 'network') return { kind: 'error', message: cause.message };
  if (cause.kind === 'http') {
    if (cause.status === 403) return { kind: 'forbidden' };
    if (cause.status === 404) return { kind: 'not-found' };
    // The platform refusing to let go (a revocation it did not accept) is the
    // server's 502, in the platform's own words. A fault of the server's own
    // is left to raise as itself.
    if (cause.status === 502) return { kind: 'error', message: cause.detail ?? cause.message };
  }
  return null;
}
