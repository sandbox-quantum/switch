import { eq, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { locationSettings as locationSettingsTable } from '@main/db/schema';

export type StoredLocationSettings = {
  baseSettingsJson: string;
  shareableSettingsJson: string;
  legacyConfigMigratedAt: string | null;
};

export interface LocationSettingsStorage {
  get(locationId: string): Promise<StoredLocationSettings | undefined>;
  insertIfMissing(locationId: string, settings: StoredLocationSettings): Promise<void>;
  update(locationId: string, settings: Partial<StoredLocationSettings>): Promise<void>;
}

export class LocationSettingsRepository implements LocationSettingsStorage {
  async get(locationId: string): Promise<StoredLocationSettings | undefined> {
    const row = db
      .select()
      .from(locationSettingsTable)
      .where(eq(locationSettingsTable.locationId, locationId))
      .get();
    if (!row) return undefined;
    return {
      baseSettingsJson: row.baseSettingsJson,
      shareableSettingsJson: row.shareableSettingsJson,
      legacyConfigMigratedAt: row.legacyConfigMigratedAt,
    };
  }

  async insertIfMissing(locationId: string, settings: StoredLocationSettings): Promise<void> {
    await db
      .insert(locationSettingsTable)
      .values({
        locationId,
        baseSettingsJson: settings.baseSettingsJson,
        shareableSettingsJson: settings.shareableSettingsJson,
        legacyConfigMigratedAt: settings.legacyConfigMigratedAt,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .onConflictDoNothing();
  }

  async update(locationId: string, settings: Partial<StoredLocationSettings>): Promise<void> {
    await db
      .update(locationSettingsTable)
      .set({
        ...settings,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(locationSettingsTable.locationId, locationId));
  }
}
