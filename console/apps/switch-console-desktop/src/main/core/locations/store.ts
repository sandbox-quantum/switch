import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { agents, locations, type LocationRow } from '@main/db/schema';
import type { Location } from '@shared/core/locations/locations';

function rowToLocation(row: LocationRow): Location {
  return {
    id: row.id,
    name: row.name,
    sshHost: row.sshHost === '' ? null : row.sshHost,
    dir: row.dir,
    observed: row.observed,
    observedOwner: row.observedOwner ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getLocations(): Promise<Location[]> {
  const rows = await db.select().from(locations).orderBy(desc(locations.updatedAt));
  return rows.map(rowToLocation);
}

export async function getLocationById(locationId: string): Promise<Location | undefined> {
  const [row] = await db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
  if (!row) return undefined;
  return rowToLocation(row);
}

export async function getLocationByHostDir(
  sshHost: string | null,
  dir: string
): Promise<Location | undefined> {
  const [row] = await db
    .select()
    .from(locations)
    .where(and(eq(locations.sshHost, sshHost ?? ''), eq(locations.dir, dir)))
    .limit(1);
  if (!row) return undefined;
  return rowToLocation(row);
}

/**
 * Find the location for (sshHost, dir), creating it if none exists. The name
 * is only applied on create — an existing location keeps its name.
 */
export async function ensureLocation(params: {
  sshHost: string | null;
  dir: string;
  name: string;
}): Promise<Location> {
  const existing = await getLocationByHostDir(params.sshHost, params.dir);
  if (existing) {
    if (existing.observed) {
      // A place this Console only observes cannot also be one it runs agents
      // in: the directory is another account's, so every write and launch
      // there would fail, or act as the wrong person.
      throw new ObservedLocationError(existing);
    }
    return existing;
  }
  const [row] = await db
    .insert(locations)
    .values({
      id: randomUUID(),
      name: params.name,
      sshHost: params.sshHost ?? '',
      dir: params.dir,
    })
    .returning();
  return rowToLocation(row!);
}

/**
 * Find or create the location for a directory another account on a shared host
 * runs agents in (CHOO-2893), marked as observed. An existing location at the
 * same place that this Console runs agents in is refused rather than turned
 * observed — its agents would lose their runtime underneath them.
 */
export async function ensureObservedLocation(params: {
  sshHost: string;
  dir: string;
  name: string;
  owner: string | null;
}): Promise<Location> {
  const existing = await getLocationByHostDir(params.sshHost, params.dir);
  if (existing) {
    if (!existing.observed) {
      throw new Error(
        `${params.dir} on ${params.sshHost} is already a location this Console runs agents in, ` +
          `so it cannot also be one it only observes.`
      );
    }
    return existing;
  }
  const [row] = await db
    .insert(locations)
    .values({
      id: randomUUID(),
      name: params.name,
      sshHost: params.sshHost,
      dir: params.dir,
      observed: true,
      observedOwner: params.owner,
    })
    .returning();
  return rowToLocation(row!);
}

/**
 * Drop an observed location once no agent is left at it (CHOO-2893). Unlike a
 * location this Console runs agents in, which is kept for reuse, an observed
 * one only stands for agents followed there; left behind, it would refuse the
 * directory for good — should its owner later share it, it could be neither
 * loaded the ordinary way nor followed.
 */
export async function forgetObservedLocationIfUnused(locationId: string): Promise<void> {
  const [row] = await db.select().from(locations).where(eq(locations.id, locationId)).limit(1);
  if (!row?.observed) return;
  const [remaining] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.locationId, locationId))
    .limit(1);
  if (remaining) return;
  await db.delete(locations).where(eq(locations.id, locationId));
}

/** Refuse, with {@link ObservedLocationError}, a location this Console only
 * observes — the one check every path that would run or write there makes. */
export function assertRunsHere(location: Location): void {
  if (location.observed) throw new ObservedLocationError(location);
}

/** Raised when something tries to run agents at, or write to, a location this
 * Console only observes. */
export class ObservedLocationError extends Error {
  constructor(location: Pick<Location, 'dir' | 'sshHost' | 'observedOwner'>) {
    super(
      `${location.dir}${location.sshHost ? ` on ${location.sshHost}` : ''} belongs to ` +
        `${location.observedOwner ? `the account ${location.observedOwner}` : 'another account'}, ` +
        `so its agents run from that account's Switch Console. This Console can follow and ` +
        `drive their sessions, but runs nothing there.`
    );
    this.name = 'ObservedLocationError';
  }
}
