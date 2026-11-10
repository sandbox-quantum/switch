import { eq, isNotNull } from 'drizzle-orm';
import { db } from '@main/db/client';
import {
  agents,
  locations,
  remoteHostReachability,
  type RemoteHostReachabilityRow,
  remoteHosts,
  remoteHostSetupPlans,
  switchServers,
} from '@main/db/schema';
import {
  type HostReachability,
  type HostReachabilityStatus,
  unknownHostReachability,
} from '@shared/core/remote-hosts/reachability';

/** Persisted shape of a reachability record — everything except live probe state. */
export type PersistedHostReachability = Omit<HostReachability, 'nextProbeAt' | 'probing'>;

const STATUSES: HostReachabilityStatus[] = ['unknown', 'reachable', 'unreachable', 'suspended'];

function toStatus(raw: string, sshHost: string): HostReachabilityStatus {
  const status = STATUSES.find((s) => s === raw);
  if (!status) {
    throw new Error(`Unknown reachability status '${raw}' persisted for host ${sshHost}`);
  }
  return status;
}

function toRecord(row: RemoteHostReachabilityRow): PersistedHostReachability {
  return {
    sshHost: row.sshHost,
    status: toStatus(row.status, row.sshHost),
    lastError: row.lastError,
    lastCheckedAt: row.lastCheckedAt,
    lastReachableAt: row.lastReachableAt,
    consecutiveFailures: row.consecutiveFailures,
  };
}

export async function listPersistedReachability(): Promise<PersistedHostReachability[]> {
  const rows = await db.select().from(remoteHostReachability);
  return rows.map(toRecord);
}

export async function getPersistedReachability(
  sshHost: string
): Promise<PersistedHostReachability | null> {
  const [row] = await db
    .select()
    .from(remoteHostReachability)
    .where(eq(remoteHostReachability.sshHost, sshHost))
    .limit(1);
  return row ? toRecord(row) : null;
}

export async function savePersistedReachability(record: PersistedHostReachability): Promise<void> {
  const values = {
    sshHost: record.sshHost,
    status: record.status,
    lastError: record.lastError,
    lastCheckedAt: record.lastCheckedAt,
    lastReachableAt: record.lastReachableAt,
    consecutiveFailures: record.consecutiveFailures,
    updatedAt: new Date().toISOString(),
  };
  await db
    .insert(remoteHostReachability)
    .values(values)
    .onConflictDoUpdate({ target: remoteHostReachability.sshHost, set: values });
}

export async function deletePersistedReachability(sshHost: string): Promise<void> {
  await db.delete(remoteHostReachability).where(eq(remoteHostReachability.sshHost, sshHost));
}

/**
 * SSH hosts something still needs reached: onboarded, mid-setup, running a
 * managed server, or holding a location with at least one agent.
 */
export async function listSshHostsInUse(): Promise<Set<string>> {
  const rows = await Promise.all([
    db.select({ sshHost: remoteHosts.sshHost }).from(remoteHosts),
    db.select({ sshHost: remoteHostSetupPlans.sshHost }).from(remoteHostSetupPlans),
    db
      .select({ sshHost: switchServers.sshHost })
      .from(switchServers)
      .where(isNotNull(switchServers.sshHost)),
    db
      .selectDistinct({ sshHost: locations.sshHost })
      .from(locations)
      .innerJoin(agents, eq(agents.locationId, locations.id)),
  ]);
  return new Set(rows.flat().flatMap((row) => (row.sshHost ? [row.sshHost] : [])));
}

/** A persisted record widened back to the full live shape (no probe scheduled yet). */
export function hydrate(record: PersistedHostReachability): HostReachability {
  return { ...record, nextProbeAt: null, probing: false };
}

export function emptyFor(sshHost: string): HostReachability {
  return unknownHostReachability(sshHost);
}
