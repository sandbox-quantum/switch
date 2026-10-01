/**
 * Which tenant a server's session is currently selecting on behalf of the calls
 * holding a lease on it.
 *
 * The session seam owns this; it lives in a module of its own so the gateway
 * client can read it without importing the seam that switches tenants through
 * the gateway client.
 *
 * Every lease outstanding on a server at one moment names the same tenant — a
 * switch waits for every lease to be given up first — so there is one answer per
 * server rather than one per call.
 */
const asserted = new Map<string, string>();

/** Record the tenant `serverId`'s first outstanding lease was taken against. */
export function setAssertedTenant(serverId: string, tenantId: string): void {
  asserted.set(serverId, tenantId);
}

/** Forget it once nothing is leasing the server. */
export function clearAssertedTenant(serverId: string): void {
  asserted.delete(serverId);
}

/**
 * The tenant that has to hold for the calls in flight on `serverId`, or null
 * when nothing is leasing it or the lease named no tenant.
 *
 * Read by anything that replaces the session cookie underneath those calls: a
 * cookie minted by a fresh login selects no tenant, and handing it back
 * unchanged would answer the rest of the lease with the account's default
 * workspace while the caller still believes it is addressing the one it named.
 */
export function assertedTenant(serverId: string): string | null {
  return asserted.get(serverId) ?? null;
}
