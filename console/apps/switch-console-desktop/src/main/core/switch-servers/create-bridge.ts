import { createBridge, GatewayError } from '@main/core/switch-servers/gateway-client';
import type {
  CreateBridgeParams,
  CreateBridgeResult,
  SwitchServer,
} from '@shared/core/switch-servers/switch-servers';

/**
 * Attach a collaboration bridge to `server` and map recoverable gateway
 * failures onto a typed {@link CreateBridgeResult}, so the modal can name what
 * went wrong instead of surfacing a raw status line.
 *
 * Unmapped failures still throw: an unexpected 500 is a bug, not a form error.
 *
 * Nothing here logs `params.connectionConfig`, and nothing returns it. The
 * credentials exist in this process only for the duration of the call —
 * Switch Console never persists them; the server is where they live.
 */
export async function createBridgeOnServer(
  server: SwitchServer,
  params: Omit<CreateBridgeParams, 'serverId'>
): Promise<CreateBridgeResult> {
  try {
    const bridge = await createBridge(server, {
      bridgeType: params.bridgeType,
      displayName: params.displayName,
      connectionConfig: params.connectionConfig,
      setAsDefault: params.setAsDefault,
    });
    return { kind: 'created', bridge };
  } catch (cause) {
    if (cause instanceof GatewayError) {
      if (cause.kind === 'unauthorized') return { kind: 'unauthenticated' };
      // Registering a bridge is admin-only. A non-admin cannot fix this by
      // editing the form, so it is not a validation failure.
      if (cause.kind === 'http' && cause.status === 403) return { kind: 'forbidden' };
      if (cause.kind === 'http' && (cause.status === 400 || cause.status === 422)) {
        return { kind: 'invalid', message: cause.detail ?? cause.message };
      }
      if (cause.kind === 'network') return { kind: 'error', message: cause.message };
    }
    throw cause;
  }
}
