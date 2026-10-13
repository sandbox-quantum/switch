import {
  clearTrustSettings,
  fetchTrustSettings,
  GatewayError,
  updateTrustSettings,
} from '@main/core/switch-servers/gateway-client';
import type {
  ClearTrustSettingsResult,
  FetchTrustSettingsResult,
  SwitchServer,
  UpdateTrustSettingsParams,
  UpdateTrustSettingsResult,
} from '@shared/core/switch-servers/switch-servers';

/**
 * Load Switch Trust's one server-global settings row, mapping recoverable
 * gateway failures the same way the write paths below do — a non-operator
 * gets `forbidden` rather than a thrown error, so the settings page can say
 * why rather than showing a generic failure banner.
 */
export async function fetchTrustSettingsFromServer(
  server: SwitchServer
): Promise<FetchTrustSettingsResult> {
  try {
    return { kind: 'loaded', settings: await fetchTrustSettings(server) };
  } catch (cause) {
    const result = recoverableResult(cause);
    if (result) return result;
    throw cause;
  }
}

/**
 * Save Switch Trust's settings and map recoverable gateway failures onto a
 * typed {@link UpdateTrustSettingsResult}, mirroring `updateBridgeOnServer`.
 *
 * Unmapped failures still throw: an unexpected 500 is a bug, not a form error.
 */
export async function updateTrustSettingsOnServer(
  server: SwitchServer,
  params: Omit<UpdateTrustSettingsParams, 'serverId'>
): Promise<UpdateTrustSettingsResult> {
  try {
    return { kind: 'saved', settings: await updateTrustSettings(server, params) };
  } catch (cause) {
    if (cause instanceof GatewayError && cause.kind === 'http') {
      if (cause.status === 400 || cause.status === 422) {
        return { kind: 'invalid', message: cause.detail ?? cause.message };
      }
    }
    const result = recoverableResult(cause);
    if (result) return result;
    throw cause;
  }
}

/** Turn Switch Trust off and map recoverable gateway failures onto a typed
 * {@link ClearTrustSettingsResult}. */
export async function clearTrustSettingsOnServer(
  server: SwitchServer
): Promise<ClearTrustSettingsResult> {
  try {
    return { kind: 'cleared', settings: await clearTrustSettings(server) };
  } catch (cause) {
    const result = recoverableResult(cause);
    if (result) return result;
    throw cause;
  }
}

/** The three failure cases every Switch Trust settings call can produce —
 * common across load, save and clear because all three sit behind the same
 * `require_admin` gate. */
function recoverableResult(
  cause: unknown
): { kind: 'unauthenticated' } | { kind: 'forbidden' } | { kind: 'error'; message: string } | null {
  if (!(cause instanceof GatewayError)) return null;
  if (cause.kind === 'unauthorized') return { kind: 'unauthenticated' };
  if (cause.kind === 'network') return { kind: 'error', message: cause.message };
  if (cause.kind === 'http' && cause.status === 403) return { kind: 'forbidden' };
  return null;
}
