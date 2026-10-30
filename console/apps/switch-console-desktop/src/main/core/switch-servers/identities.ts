import {
  cancelIdentityLinkRequest,
  claimBridgeIdentity,
  fetchBridges,
  GatewayError,
  issueIdentityLinkCode,
  mapLinkCode,
  requireLinkConfirmation,
  searchBridgeDirectory,
} from '@main/core/switch-servers/gateway-client';
import type {
  BridgeDirectorySearchResult,
  CancelLinkRequestResult,
  ClaimIdentityParams,
  ClaimIdentityResult,
  IssueLinkCodeResult,
  RequireLinkConfirmationResult,
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
 * bridge's display name so the caller gets a complete row rather than one it
 * has to name itself.
 *
 * A current server leaves the link pending until a code is posted from the
 * account, and answers with that code; one that predates confirming links, or a
 * link already confirmed, comes back claimed. Claiming an account the caller
 * already holds an unconfirmed link to also comes back pending, and says so:
 * that link works meanwhile, and cancelling must leave it standing.
 *
 * Nothing here refuses an account other people have claimed — the server
 * allows it, and each claimant is recognised as themselves on the account.
 */
export async function claimIdentityOnServer(
  server: SwitchServer,
  params: Omit<ClaimIdentityParams, 'workspaceId'>
): Promise<ClaimIdentityResult> {
  try {
    const claimed = await claimBridgeIdentity(server, params.bridgeId, {
      externalUserId: params.externalUserId,
      username: params.username,
    });
    const bridge = (await fetchBridges(server)).find((b) => b.id === claimed.bridge_id);
    const row = {
      id: claimed.id,
      bridgeId: claimed.bridge_id,
      // A bridge deleted between the claim and this read leaves nothing to
      // name it by; its id still identifies the row rather than hiding it.
      bridgeDisplayName: bridge?.displayName ?? claimed.bridge_id,
      bridgeType: bridge?.type ?? '',
      externalUserId: claimed.external_user_id,
      externalUsername: claimed.external_username,
    };
    const request = claimed.link_request ?? null;
    if (request !== null) {
      const code = request.code === null ? null : mapLinkCode(request.code);
      return {
        kind: 'pending',
        pending: { ...row, requestedByName: null, codeExpiresAt: code?.expiresAt ?? null },
        code,
        alreadyLinked: (claimed.claimed_by ?? []).some((c) => c.user_id === request.user_id),
      };
    }
    return { kind: 'claimed', identity: { ...row, verified: true } };
  } catch (cause) {
    if (cause instanceof GatewayError) {
      if (cause.kind === 'unauthorized') return { kind: 'unauthenticated' };
      // 409 — the bridge is not running, so an account Switch has never seen
      // cannot be provisioned; or the account is a platform stand-in nobody
      // can link. The server's wording says which. Claiming an account someone
      // else has claimed is not a conflict: claims are not exclusive.
      if (cause.kind === 'http' && cause.status === 409) {
        return { kind: 'bridge-unavailable', message: cause.detail ?? cause.message };
      }
      if (cause.kind === 'network') return { kind: 'error', message: cause.message };
    }
    throw cause;
  }
}

/**
 * A fresh code confirming the signed-in user's link to an account, replacing
 * any issued before. 404 (nothing to confirm — the link was cancelled) and 409
 * (already confirmed, or an account nobody can link) are the server's to word.
 */
export async function issueLinkCodeOnServer(
  server: SwitchServer,
  bridgeId: string,
  identityId: string
): Promise<IssueLinkCodeResult> {
  try {
    return { kind: 'issued', code: await issueIdentityLinkCode(server, bridgeId, identityId) };
  } catch (cause) {
    if (cause instanceof GatewayError) {
      if (cause.kind === 'unauthorized') return { kind: 'unauthenticated' };
      if (cause.kind === 'http' && (cause.status === 404 || cause.status === 409)) {
        return { kind: 'refused', message: cause.detail ?? cause.message };
      }
      if (cause.kind === 'network') return { kind: 'error', message: cause.message };
    }
    throw cause;
  }
}

/**
 * Withdraw the signed-in user's confirmation waiting on a code, leaving any link
 * that already works in place. 404 — nothing is waiting, because it was
 * confirmed or cancelled meanwhile — is the server's to word.
 */
export async function cancelLinkRequestOnServer(
  server: SwitchServer,
  bridgeId: string,
  identityId: string
): Promise<CancelLinkRequestResult> {
  try {
    await cancelIdentityLinkRequest(server, bridgeId, identityId);
    return { kind: 'cancelled' };
  } catch (cause) {
    if (cause instanceof GatewayError) {
      if (cause.kind === 'unauthorized') return { kind: 'unauthenticated' };
      if (cause.kind === 'http' && cause.status === 404) {
        return { kind: 'refused', message: cause.detail ?? cause.message };
      }
      if (cause.kind === 'network') return { kind: 'error', message: cause.message };
    }
    throw cause;
  }
}

/**
 * Require confirmation of a messaging app's older links. 403 — the caller is
 * not an admin of the workspace — and 404 — the app is gone, or the server
 * predates this — are the server's to word.
 */
export async function requireLinkConfirmationOnServer(
  server: SwitchServer,
  bridgeId: string
): Promise<RequireLinkConfirmationResult> {
  try {
    return { kind: 'required', moved: await requireLinkConfirmation(server, bridgeId) };
  } catch (cause) {
    if (cause instanceof GatewayError) {
      if (cause.kind === 'unauthorized') return { kind: 'unauthenticated' };
      if (cause.kind === 'http' && (cause.status === 403 || cause.status === 404)) {
        return { kind: 'refused', message: cause.detail ?? cause.message };
      }
      if (cause.kind === 'network') return { kind: 'error', message: cause.message };
    }
    throw cause;
  }
}
