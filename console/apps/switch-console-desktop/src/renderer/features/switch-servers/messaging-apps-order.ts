import type { RemoteBridge } from '@shared/core/switch-servers/switch-servers';

/**
 * The order the messaging apps table lists apps in.
 *
 * Decided here rather than taken as the gateway sends it, because the gateway
 * makes no promise about order: flipping one row's channel switch refetches the
 * list, and an order that follows the response deals the whole table out again
 * underneath the cursor of whoever just clicked. Name, then id — the tiebreak
 * matters because two apps really can share a display name.
 */
export function orderBridges(bridges: readonly RemoteBridge[]): RemoteBridge[] {
  return [...bridges].sort(
    (a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id)
  );
}
