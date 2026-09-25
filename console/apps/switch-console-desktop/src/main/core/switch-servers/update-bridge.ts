import { GatewayError, updateBridge } from '@main/core/switch-servers/gateway-client';
import type {
  SwitchServer,
  UpdateBridgeParams,
  UpdateBridgeResult,
} from '@shared/core/switch-servers/switch-servers';

/**
 * Edit a bridge's operator-controlled switches on `server` and map recoverable
 * gateway failures onto a typed {@link UpdateBridgeResult}, mirroring
 * `createBridgeOnServer` — editing is admin-only for the same reason
 * registering is, so the same recoverable cases apply.
 *
 * Unmapped failures still throw: an unexpected 500 is a bug, not a form error.
 */
export async function updateBridgeOnServer(
  server: SwitchServer,
  params: Omit<UpdateBridgeParams, 'serverId'>
): Promise<UpdateBridgeResult> {
  try {
    const bridge = await updateBridge(server, params.bridgeId, {
      channelCreationEnabled: params.channelCreationEnabled,
    });
    return { kind: 'updated', bridge };
  } catch (cause) {
    if (cause instanceof GatewayError) {
      if (cause.kind === 'unauthorized') return { kind: 'unauthenticated' };
      if (cause.kind === 'http' && cause.status === 403) return { kind: 'forbidden' };
      // Also where turning channel creation on for a platform that cannot do
      // it lands (400, naming the platform) — a rejected argument, not its
      // own case.
      if (cause.kind === 'http' && (cause.status === 400 || cause.status === 422)) {
        return { kind: 'invalid', message: cause.detail ?? cause.message };
      }
      if (cause.kind === 'network') return { kind: 'error', message: cause.message };
    }
    throw cause;
  }
}
