import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { locations, type LocationRow } from '@main/db/schema';
import type { Location } from '@shared/core/locations/locations';

function rowToLocation(row: LocationRow): Location {
  return {
    id: row.id,
    name: row.name,
    sshHost: row.sshHost === '' ? null : row.sshHost,
    dir: row.dir,
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
  if (existing) return existing;
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
