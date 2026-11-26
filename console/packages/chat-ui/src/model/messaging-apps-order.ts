import type { RemoteBridge } from '../contracts/switch-servers';

export function orderBridges(bridges: readonly RemoteBridge[]): RemoteBridge[] {
  return [...bridges].sort(
    (a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id)
  );
}
