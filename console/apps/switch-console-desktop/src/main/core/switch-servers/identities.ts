import {
  claimBridgeIdentity,
  fetchBridges,
  GatewayError,
  searchBridgeDirectory,
} from '@main/core/switch-servers/gateway-client';
import type {
  BridgeDirectorySearchResult,
  ClaimIdentityParams,
  ClaimIdentityResult,
  SwitchServer,
} from '@shared/core/switch-servers/switch-servers';

/**
 * Linking a Switch user to their messaging-app account (CHOO-2137), with the
 * gateway's recoverable failures mapped onto typed results.
 *
 * The mapping matters more here than elsewhere: a platform with no searchable
 * directory and a platform where nobody matched are the same empty screen
 * unless the difference is carried through, and the server's own wording is
 * the only thing that tells the user what to do instead. Current servers
 * narrow such a search to the accounts they have already seen and say so in a
 * note; only an older one refuses it outright.
 */

/**
 * Search a bridge's user directory. Anything the user can act on becomes a
 * variant; an unexpected failure still throws, because inventing an empty
 * result for a broken server is how a claim flow silently stops working.
 */
export async function searchDirectoryOnServer(
  server: SwitchServer,
  bridgeId: string,
  query: string
): Promise<BridgeDirectorySearchResult> {
  try {
    const { users, note } = await searchBridgeDirectory(server, bridgeId, query);
    return { kind: 'results', users, note };
  } catch (cause) {
    if (cause instanceof GatewayError) {
      if (cause.kind === 'unauthorized') return { kind: 'unauthenticated' };
      // 501 — the platform has no directory to search. The detail explains that
      // a message has to arrive first, which is the only route left.
      if (cause.kind === 'http' && cause.status === 501) {
        return { kind: 'unsupported', message: cause.detail ?? cause.message };
      }
      // 409 — the bridge is registered but its adapter is not running.
      if (cause.kind === 'http' && cause.status === 409) {
        return { kind: 'bridge-unavailable', message: cause.detail ?? cause.message };
      }
      // 502 — the platform itself refused or failed the lookup.
      if (cause.kind === 'http' && cause.status === 502) {
        return { kind: 'error', message: cause.detail ?? cause.message };
      }
      if (cause.kind === 'network') return { kind: 'error', message: cause.message };
    }
    throw cause;
  }
}

/**
 * Claim a directory entry as the signed-in user's own account, resolving the
 * bridge's display name so the caller gets a complete `LinkedIdentity` rather
 * than a row it has to name itself.
 *
 * Nothing here refuses an account other people have claimed — the server
 * allows it, and each claimant is recognised as themselves on the account.
 */
export async function claimIdentityOnServer(
  server: SwitchServer,
  params: Omit<ClaimIdentityParams, 'serverId'>
): Promise<ClaimIdentityResult> {
  try {
    const claimed = await claimBridgeIdentity(server, params.bridgeId, {
      externalUserId: params.externalUserId,
      username: params.username,
    });
    const bridge = (await fetchBridges(server)).find((b) => b.id === claimed.bridge_id);
    return {
      kind: 'claimed',
      identity: {
        id: claimed.id,
        bridgeId: claimed.bridge_id,
        // A bridge deleted between the claim and this read leaves nothing to
        // name it by; its id still identifies the row rather than hiding it.
        bridgeDisplayName: bridge?.displayName ?? claimed.bridge_id,
        bridgeType: bridge?.type ?? '',
        externalUserId: claimed.external_user_id,
        externalUsername: claimed.external_username,
      },
    };
  } catch (cause) {
    if (cause instanceof GatewayError) {
      if (cause.kind === 'unauthorized') return { kind: 'unauthenticated' };
      // 409 — the bridge is not running, so an account Switch has never seen
      // cannot be provisioned. Claiming an account someone else has claimed is
      // not a conflict: claims are not exclusive.
      if (cause.kind === 'http' && cause.status === 409) {
        return { kind: 'bridge-unavailable', message: cause.detail ?? cause.message };
      }
      if (cause.kind === 'network') return { kind: 'error', message: cause.message };
    }
    throw cause;
  }
}
